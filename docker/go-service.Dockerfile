FROM golang:1.23-bookworm AS build

ARG SERVICE_DIR

WORKDIR /src
COPY apps ./apps

WORKDIR /src/apps/${SERVICE_DIR}
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/service ./cmd/service

FROM gcr.io/distroless/base-debian12

COPY --from=build /out/service /service

ENTRYPOINT ["/service"]
