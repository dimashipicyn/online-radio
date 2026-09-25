FROM debian:bookworm-slim

RUN sed -i 's|deb.debian.org|mirror.yandex.ru|g; s|security.debian.org|mirror.yandex.ru|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
    && apt-get update \
    && apt-get install -y --no-install-recommends icecast2 curl gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY icecast.xml.tpl /etc/icecast2/icecast.xml.tpl
COPY web/status.xsl /usr/share/icecast2/web/status.xsl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /var/log/icecast2 \
    && chown -R icecast2:icecast /var/log/icecast2 /etc/icecast2

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
