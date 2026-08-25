#!/usr/bin/env python3
"""
lint.py — проверки канона RPIV × praxis-ba.

Две группы проверок, и разница между ними важна.

СМЫСЛОВЫЕ (1–5) — дисциплина, которой в движке нет вовсе. Запускаются всегда,
дублирования с `praxis-ba validate` не дают (обоснование — mapping.md, раздел 5):
  1. [NEEDS CLARIFICATION] в артефакте, у которого статус уже active или выше
  2. Ссылка на каталог НФР проекта указывает на несуществующий ID
  3. Тег не входит в словарь shared/taxonomy.md
  4. Требование active/batched/baselined, а его эпик ещё draft
  5. Битая относительная ссылка на .md

СТРУКТУРНЫЕ (6–9) — подмена проверок движка на время работы без него.
Соответствуют его `no-dangling-refs`, `schema-valid` (в части ID),
`id-max-guard` и `counters-monotonic`. Когда `praxis-ba` подключат, эту группу
можно отключить ключом --no-structural: она станет дублем.
  6. Ссылка фронтматтера (epic / enforces / references_nfr / related / traces_to)
     ведёт в артефакт, которого в каноне нет
  7. Один и тот же ID выдан двум артефактам
  8. ID не совпадает с именем файла (для эпика — с именем его папки)
  9. counters.yaml отстаёт от фактически выданных ID

Использование:
    python3 lint.py <путь-к-канону> [--no-structural]

Коды возврата: 0 — чисто, 1 — есть ошибки, 2 — неверный вызов.
"""
import re
import sys
from pathlib import Path

ERRORS: list[str] = []
WARNINGS: list[str] = []

# статусы, начиная с которых артефакт считается зафиксированным
COMMITTED = {"active", "batched", "baselined"}


def err(msg: str) -> None:
    ERRORS.append(msg)


def warn(msg: str) -> None:
    WARNINGS.append(msg)


def split_doc(path: Path) -> tuple[dict, str]:
    """Возвращает (фронтматтер, тело). Парсер намеренно простой:
    во фронтматтере канона только скаляры и плоские списки."""
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    block, body = parts[1], parts[2]

    fm: dict = {}
    key = None
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        # элемент многострочного списка
        if line.startswith((" ", "\t")) and line.lstrip().startswith("- ") and key:
            fm.setdefault(key, [])
            if isinstance(fm[key], list):
                fm[key].append(line.lstrip()[2:].strip().strip("\"'"))
            continue
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if not m:
            continue
        key, raw = m.group(1), m.group(2).strip()
        if raw.startswith("[") and raw.endswith("]"):
            inner = raw[1:-1].strip()
            fm[key] = [v.strip().strip("\"'") for v in inner.split(",") if v.strip()] if inner else []
        elif raw == "":
            fm[key] = []
        else:
            fm[key] = raw.strip("\"'")
    return fm, body


def canon_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*.md") if ".git" not in p.parts]


def load_taxonomy(root: Path) -> tuple[set[str], Path | None]:
    """Словарь тегов. Ищем shared/taxonomy.md рядом с каноном и на уровень выше.

    Возвращает и путь: не найден словарь — проверка тегов не выполняется, и об
    этом надо сказать вслух. Молчаливое отключение проверки хуже её отсутствия:
    прогон печатает «0 ошибок», хотя треть проверок не запускалась."""
    for candidate in (root / "shared" / "taxonomy.md", root.parent / "shared" / "taxonomy.md"):
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8")
            return set(re.findall(r"`([a-z0-9][a-z0-9-]*)`", text)), candidate
    return set(), None


def load_engine_counters(path: Path) -> dict:
    """Счётчик движка `.ba/counters.yaml` — формат вложенный:
        product:
          epic: 1
          cr: 0
        epics:
          E1:
            fr: 5
    Приводим к тому же плоскому виду, что и ручной файл."""
    data: dict = {}
    top = None          # product | epics
    epic = None         # текущий эпик внутри epics:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z][\w-]*):\s*(.*)$", line)
        if not m:
            continue
        indent, key, raw = len(m.group(1)), m.group(2), m.group(3).strip()
        if indent == 0:
            top, epic = key, None
        elif top == "product" and raw.isdigit():
            data[key] = int(raw)
        elif top == "epics":
            if raw == "":
                epic = key
            elif epic is not None and raw.isdigit():
                data.setdefault(key, {})[epic] = int(raw)
    return data


def load_counters(root: Path) -> tuple[dict, Path | None]:
    """Счётчик выданных ID. Приоритет — за движком: если канон подключён к
    `praxis-ba`, истина лежит в `.ba/counters.yaml`, и ручной `counters.yaml`
    рядом с ним — уже мусор, который будет тихо отставать.

    Ручной формат (работа без движка) плоский, поэтому парсим сами и не тянем
    зависимость:
        epic: 1
        fr:
          E1: 5
    Возвращает {'epic': 1, 'fr': {'E1': 5}, ...}."""
    engine_path = root / ".ba" / "counters.yaml"
    if engine_path.is_file():
        return load_engine_counters(engine_path), engine_path
    path = root / "counters.yaml"
    if not path.is_file():
        return {}, None
    data: dict = {}
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z][\w-]*):\s*(.*)$", line)
        if not m:
            continue
        indent, key, raw = len(m.group(1)), m.group(2), m.group(3).strip()
        if indent == 0:
            if raw == "":
                data[key] = {}
                section = key
            else:
                data[key] = int(raw) if raw.isdigit() else raw
                section = None
        elif section is not None and raw.isdigit():
            data[section][key] = int(raw)
    if not data:
        # файл есть, но значений в нём нет — например, ручной счётчик, опустошённый
        # при переходе на движок. Считаем, что счётчика нет, иначе проверка 9
        # объявит отставшим каждый выданный ID.
        return {}, None
    return data, path


def expected_stem(fm: dict, path: Path) -> str | None:
    """Как должен называться файл артефакта. У эпика файл всегда index.md,
    а ID отражён в имени папки: E1-<slug>."""
    aid = fm.get("id")
    if not aid:
        return None
    if fm.get("type") == "epic":
        folder = path.parent.name
        return aid if (folder == aid or folder.startswith(f"{aid}-")) else f"{aid}-<slug>/"
    return aid


def load_nfr_catalog(root: Path) -> tuple[str, Path | None]:
    """Каталог НФР проекта — тот самый shared/nfr.md, а не canon-NFR эпика."""
    for candidate in (root / "shared" / "nfr.md", root.parent / "shared" / "nfr.md"):
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8"), candidate
    return "", None


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    structural = "--no-structural" not in sys.argv
    if not args:
        print(__doc__)
        sys.exit(2)

    root = Path(args[0]).resolve()
    if not root.is_dir():
        print(f"Нет такой папки: {root}")
        sys.exit(2)

    files = canon_files(root)
    taxonomy, taxonomy_path = load_taxonomy(root)
    nfr_text, nfr_path = load_nfr_catalog(root)
    counters, counters_path = load_counters(root)

    epic_status: dict[str, str] = {}
    docs: list[tuple[Path, dict, str]] = []
    id_owner: dict[str, Path] = {}

    for path in files:
        fm, body = split_doc(path)
        if not fm.get("type"):
            continue
        docs.append((path, fm, body))
        if fm.get("type") == "epic" and fm.get("id"):
            epic_status[fm["id"]] = fm.get("status", "?")

        # --- 7. ID уникален в каноне ---
        aid = fm.get("id")
        if structural and aid:
            if aid in id_owner:
                err(f"{aid}: ID выдан дважды — {id_owner[aid].relative_to(root)} "
                    f"и {path.relative_to(root)}")
            else:
                id_owner[aid] = path

    if taxonomy_path is None:
        warn("словарь тегов shared/taxonomy.md не найден — проверка 3 не выполнялась")
    if nfr_path is None:
        warn("каталог НФР shared/nfr.md не найден — проверка 2 (ссылки на каталог НФР) не выполнялась")
    if structural and counters_path is None:
        warn("counters.yaml не найден — проверка 9 не выполнялась; "
             "без движка счётчик ID вести обязательно")

    # --- 9. counters.yaml не отстаёт от выданных ID ---
    if structural and counters_path is not None:
        used: dict[str, int] = {}          # epic → максимальный n
        used_child: dict[str, dict[str, int]] = {}   # тип → эпик → максимальный m
        for aid in id_owner:
            m = re.fullmatch(r"E(\d+)", aid)
            if m:
                used["epic"] = max(used.get("epic", 0), int(m.group(1)))
                continue
            m = re.fullmatch(r"(E\d+)-(FR|BR|NFR)(\d+)", aid)
            if m:
                epic, kind, num = m.group(1), m.group(2).lower(), int(m.group(3))
                used_child.setdefault(kind, {})
                used_child[kind][epic] = max(used_child[kind].get(epic, 0), num)
        if used.get("epic", 0) > int(counters.get("epic", 0) or 0):
            err(f"counters.yaml: epic = {counters.get('epic', 0)}, "
                f"а выдан E{used['epic']} — счётчик отстал, следующий ID будет дублем")
        for kind, per_epic in used_child.items():
            declared = counters.get(kind, {})
            if not isinstance(declared, dict):
                declared = {}
            for epic, num in per_epic.items():
                if num > int(declared.get(epic, 0) or 0):
                    err(f"counters.yaml: {kind}.{epic} = {declared.get(epic, 0)}, "
                        f"а выдан {epic}-{kind.upper()}{num} — счётчик отстал")

    for path, fm, body in docs:
        aid = fm.get("id", path.stem)
        status = fm.get("status", "")
        rel = path.relative_to(root)

        # --- 1. Незакрытые вопросы в зафиксированном артефакте ---
        # бэктики отсекают упоминание маркера в инструкциях шаблона
        # текст вопроса вытаскиваем вместе со счётчиком: плоский список
        # «3 × NEEDS CLARIFICATION» на эпике с сорока требованиями не говорит,
        # что решать первым
        found = re.findall(r"(?<!`)\[NEEDS CLARIFICATION:?\s*([^\]]*)", body)
        if found:
            head = f"{aid}: статус {status}, но в тексте {len(found)} × [NEEDS CLARIFICATION]" \
                if status in COMMITTED or status == "approved" \
                else f"{aid} ({status}): {len(found)} × [NEEDS CLARIFICATION]"
            for q in found:
                q = " ".join(q.split())
                head += f"\n             — {q[:100] + '…' if len(q) > 100 else q}"
            (err if status in COMMITTED or status == "approved" else warn)(head)

        # --- 2. Ссылка на каталог НФР проекта ---
        # ищем в теле «ID в каталоге проекта» и любые упоминания вида KEY-NFR-001.
        # Каталог не найден — предупредили одной строкой выше, здесь по каждой
        # ссылке не спамим (симметрично словарю тегов и счётчику).
        if nfr_path is not None:
            for ref in set(re.findall(r"\b([A-Z][A-Z0-9]{1,9}-NFR-\d{3})\b", body)):
                if ref not in nfr_text:
                    err(f"{aid}: ссылается на {ref}, в каталоге {nfr_path.name} такого ID нет")

        # --- 3. Теги по словарю ---
        # теги живут в теле, в строке «Теги» Паспорта
        m = re.search(r"\*\*Теги\*\*\s*\|\s*(.+?)\s*\|", body)
        if m and taxonomy:
            raw = m.group(1)
            if "shared/taxonomy" not in raw:  # не заполненная заглушка шаблона
                for tag in re.findall(r"[a-z0-9][a-z0-9-]*", raw):
                    if tag not in taxonomy:
                        warn(f"{aid}: тег `{tag}` отсутствует в shared/taxonomy.md")

        # --- 4. Ребёнок зафиксирован раньше родителя ---
        parent = fm.get("epic")
        if parent and status in COMMITTED:
            if parent not in epic_status:
                err(f"{aid}: epic={parent}, такого эпика в каноне нет")
            elif epic_status[parent] in ("draft", "in-review"):
                err(f"{aid}: статус {status}, а эпик {parent} ещё {epic_status[parent]}")

        # --- 5. Битые относительные ссылки ---
        for target in re.findall(r"\]\((\.\.?/[^)#]+?\.md)", body):
            if "{" in target or "XXX" in target:  # заглушка шаблона
                continue
            if not (path.parent / target).resolve().is_file():
                err(f"{rel}: битая ссылка {target}")

        if not structural:
            continue

        # --- 6. Ссылки фронтматтера ведут в существующий артефакт ---
        # Это проверка движка (no-dangling-refs). Без CLI она не выполняется
        # ничем, а висячая ссылка обнаруживается только когда разработчик
        # открывает несуществующее правило.
        for field in ("epic", "enforces", "references_nfr", "related", "traces_to"):
            value = fm.get(field)
            if not value:
                continue
            refs = value if isinstance(value, list) else [value]
            for ref in refs:
                if not ref or "{" in ref:      # заглушка шаблона
                    continue
                if ref not in id_owner:
                    err(f"{aid}: {field} ссылается на {ref}, такого артефакта в каноне нет")

        # --- 8. ID совпадает с именем файла ---
        expected = expected_stem(fm, path)
        if expected and fm.get("type") == "epic":
            if expected != aid:
                err(f"{aid}: файл эпика лежит в папке {path.parent.name}, "
                    f"ожидается {expected}")
        elif expected and path.stem != expected:
            err(f"{aid}: ID не совпадает с именем файла {path.name}")

    print(f"Проверка канона: {root.name} — {len(docs)} артефактов")
    print("Группы проверок: смысловые 1–5" + (", структурные 6–9" if structural
                                              else " (структурные отключены)"))
    if nfr_path:
        print(f"Каталог НФР: {nfr_path}")
    if taxonomy_path:
        print(f"Словарь тегов: {len(taxonomy)} значений")
    if counters_path:
        # у движка и у ручного файла имя одинаковое — печатаем путь от канона,
        # иначе непонятно, чей счётчик читается
        rel = counters_path.relative_to(root) if counters_path.is_relative_to(root) else counters_path
        engine = " (движок)" if ".ba" in counters_path.parts else " (ручной — движок не подключён)"
        print(f"Счётчик ID: {rel}{engine}")
    print()
    for e in ERRORS:
        print(f"  ОШИБКА  {e}")
    for w in WARNINGS:
        print(f"  ВНИМАНИЕ {w}")
    print(f"\nИтог: {len(ERRORS)} ошибок, {len(WARNINGS)} предупреждений")
    sys.exit(1 if ERRORS else 0)


if __name__ == "__main__":
    main()
