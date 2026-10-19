"""kubectl get pod -o json을 받아 생성 시각 기준으로 각 시점까지 걸린 초를 찍는다.

condition의 lastTransitionTime은 초 단위라서 1초보다 짧은 구간은 0이나 1로 보인다.
"""
import json
import sys
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


pod = json.load(sys.stdin)
created = ts(pod["metadata"]["creationTimestamp"])
conds = {c["type"]: ts(c["lastTransitionTime"]) for c in pod["status"].get("conditions", [])}
state = pod["status"]["containerStatuses"][0]["state"]
started = ts(state["terminated"]["startedAt"]) if "terminated" in state else None

points = [
    ("PodScheduled", conds.get("PodScheduled")),
    ("PodReadyToStartContainers", conds.get("PodReadyToStartContainers")),
    ("Initialized", conds.get("Initialized")),
    ("container startedAt", started),
]
row = "  ".join(f"{name} +{(t - created).total_seconds():.0f}s" for name, t in points if t)
print(f"{pod['metadata']['name']}: {row}")
