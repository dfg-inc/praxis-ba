# Independent product verify image
FROM node:22-bookworm AS deps
WORKDIR /workspace
COPY package.json package-lock.json* ./
COPY . .
RUN npm install

FROM deps AS test
WORKDIR /workspace
ARG SOURCE_COMMIT=unknown
ENV PRAXIS_SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["npm", "run", "verify"]
