#!/bin/sh
set -eu

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD is required}"

export ICECAST_MOUNT="${ICECAST_MOUNT:-radio.mp3}"
export ICECAST_MOUNT_NAME="${RADIO_NAME:-Online Radio}"
export ICECAST_HOSTNAME="${ICECAST_HOSTNAME:-localhost}"

envsubst < /etc/icecast2/icecast.xml.tpl > /etc/icecast2/icecast.xml
chown icecast2:icecast /etc/icecast2/icecast.xml

exec su -s /bin/sh icecast2 -c 'exec icecast2 -n -c /etc/icecast2/icecast.xml'
