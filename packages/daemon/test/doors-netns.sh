#!/bin/sh
# K-2005: the door helper with real traffic, in network namespaces, never in the host's own table. Run as root:
#   sh packages/daemon/test/doors-netns.sh <helper file>
# kc is a player (10.9.0.2, fd09::2), kh the machine with the gated ports, kd a container behind Docker-style DNAT.
set -eu
export PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH
work=$(mktemp -d)
state="$work/doors.ports"
# A copy of the helper that keeps its state here, never in the machine's /var/lib/kitshn.
helper="$work/doors"
sed "s|^state=/var/lib/kitshn/doors.ports$|state=$state|" "${1:?usage: doors-netns.sh <helper file>}" >"$helper"
grep -q "^state=$state$" "$helper" || { echo "FAIL the helper has no state line to replace"; exit 1; }
failures=0
cleanup() {
  for pid in $(cat "$work/pids" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  for ns in kc kh kd; do ip netns del "$ns" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT
for ns in kc kh kd; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
ip link add kc0 netns kc type veth peer name kh0 netns kh
ip link add kh1 netns kh type veth peer name kd0 netns kd
ip -n kc addr add 10.9.0.2/24 dev kc0; ip -n kc addr add fd09::2/64 dev kc0 nodad
ip -n kh addr add 10.9.0.1/24 dev kh0; ip -n kh addr add fd09::1/64 dev kh0 nodad
ip -n kh addr add 10.9.1.1/24 dev kh1; ip -n kd addr add 10.9.1.2/24 dev kd0
for link in "kc kc0" "kh kh0" "kh kh1" "kd kd0"; do set -- $link; ip -n "$1" link set "$2" up; done
ip -n kd route add default via 10.9.1.1
ip netns exec kh sysctl -qw net.ipv4.ip_forward=1
# Docker-style: kh forwards 25566 to the container.
ip netns exec kh nft -f - <<'NFT'
table ip dockerish {
  chain pre {
    type nat hook prerouting priority dstnat;
    tcp dport 25566 dnat to 10.9.1.2:25566
  }
}
NFT
listen() { # namespace, port
  ip netns exec "$1" python3 -c "
import socket
s = socket.socket(socket.AF_INET6); s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('::', $2)); s.listen(16)
while True: s.accept()[0].close()" &
  echo $! >>"$work/pids"
}
listen kh 25565
listen kd 25566
sleep 1
reach() { ip netns exec kc timeout 2 python3 -c "import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 1.5)" "$1" "$2" 2>/dev/null; }
expect() { # open|closed, address, port, what
  if reach "$2" "$3"; then got=open; else got=closed; fi
  if [ "$got" = "$1" ]; then echo "ok   $4: $got"; else echo "FAIL $4: $got, not $1"; failures=$((failures + 1)); fi
}
apply() { ip netns exec kh sh "$helper" apply; }

expect open 10.9.0.1 25565 "no table: gated port"
expect open 10.9.0.1 25566 "no table: forwarded port"
printf 'port tcp 25565\nport tcp 25566\n' | apply
expect closed 10.9.0.1 25565 "no door: gated port"
expect closed 10.9.0.1 25566 "no door: forwarded (DNAT) port"
expect closed fd09::1 25565 "no door: gated port over IPv6"
printf 'port tcp 25565\nport tcp 25566\nopen4 10.9.0.2 tcp 25565 60\nopen4 10.9.0.2 tcp 25566 60\n' | apply
expect open 10.9.0.1 25565 "IPv4 door: gated port"
expect open 10.9.0.1 25566 "IPv4 door: forwarded (DNAT) port"
expect closed fd09::1 25565 "IPv4 door: IPv6 stays closed"
printf 'port tcp 25565\nopen6 fd09:0:0:0:: tcp 25565 60\n' | apply
expect open fd09::1 25565 "IPv6 /64 door"
expect closed 10.9.0.1 25565 "IPv6 door: IPv4 stays closed"
printf 'port tcp 25565\nopen4 10.9.0.2 tcp 25565 2\n' | apply
sleep 3
expect closed 10.9.0.1 25565 "a 2 s door after 3 s"
# A reboot: the table is gone; boot loads the last gated ports with no door before anything listens.
ip netns exec kh nft delete table inet kitshn_doors
expect open 10.9.0.1 25565 "after a reboot, before boot"
ip netns exec kh sh "$helper" boot
expect closed 10.9.0.1 25565 "after a reboot, after boot"
# A damaged port file: the bad line is skipped, and the good port still loads closed.
ip netns exec kh nft delete table inet kitshn_doors
printf 'port tcp 25565\nport tcp 80\ngarbage\n' >"$state"
ip netns exec kh sh "$helper" boot 2>/dev/null
expect closed 10.9.0.1 25565 "a damaged port file at boot"
for bad in 'port tcp 80' 'open4 10.9.0.2;x tcp 25565 60' 'open6 fd09::1 tcp 25565 60' 'port tcp 25565 extra' 'open4 10.9.0.2 tcp 25565 999999'; do
  if printf '%s\n' "$bad" | apply 2>/dev/null; then echo "FAIL took: $bad"; failures=$((failures + 1)); else echo "ok   refused: $bad"; fi
done
ip netns exec kh sh "$helper" off
expect open 10.9.0.1 25565 "off: gated port"
[ ! -e "$state" ] || { echo "FAIL off left the state file"; failures=$((failures + 1)); }
echo "$failures failures"
[ "$failures" -eq 0 ]
