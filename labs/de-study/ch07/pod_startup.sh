#!/usr/bin/env bash
# Pod 하나가 끝날 때까지의 구간을 condition 시각과 kubelet 이벤트로 나눠 본다.
# 사용법: ./pod_startup.sh [반복 수] [이미지]
# 예:     ./pod_startup.sh 5 busybox:1.36
set -euo pipefail
N=${1:-5}
IMAGE=${2:-busybox:1.36}
HERE=$(cd "$(dirname "$0")" && pwd)

for i in $(seq 1 "$N"); do
  name="startup-$i-$RANDOM"
  kubectl run "$name" --image="$IMAGE" --restart=Never --image-pull-policy=IfNotPresent \
    -- sh -c 'sleep 1' >/dev/null
  kubectl wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$name" --timeout=180s >/dev/null
  kubectl get pod "$name" -o json | python3 "$HERE/parse_pod.py"
  kubectl get events --field-selector "involvedObject.name=$name" \
    -o custom-columns=REASON:.reason,MESSAGE:.message --no-headers | grep -E '^(Pulled|Pulling)' || true
  kubectl delete pod "$name" --wait=false >/dev/null
done
