FROM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /stift .

FROM scratch
COPY --from=build /stift /stift
VOLUME /data
EXPOSE 8580
ENTRYPOINT ["/stift"]
CMD ["serve", "--data", "/data"]
