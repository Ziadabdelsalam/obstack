# Build context is services/ingest — the module is self-contained (D2).
FROM golang:1.25.4-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ingest ./cmd/ingest

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ingest /ingest
USER nonroot:nonroot
EXPOSE 4317 4318 8080
ENTRYPOINT ["/ingest"]
