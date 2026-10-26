# DE 공부 8편 실습: Pod 기동 구간 나눠 보기

쿠버네티스 클러스터(예: kind)가 필요하다. 아직 직접 돌려 결과를 기록하지 않았다.

```bash
kind create cluster --name pod-lab
./pod_startup.sh 5 busybox:1.36        # 첫 번째는 이미지 pull이 들어가고 나머지는 캐시를 쓴다
./pod_startup.sh 3 python:3.12          # 더 큰 이미지로 pull 구간 비교
kind delete cluster --name pod-lab
```

출력: Pod마다 생성 시각 기준으로 PodScheduled, PodReadyToStartContainers, Initialized, 컨테이너 시작까지 걸린 초와 kubelet의 Pulled 이벤트 메시지(실제 pull 시간이 찍힌다).

주의
- condition 시각은 초 단위라 1초보다 짧은 구간은 구분되지 않는다. 더 잘게 보려면 kubelet 메트릭(`kubelet_pod_start_sli_duration_seconds`, `kubelet_pod_start_total_duration_seconds`, `kubelet_image_pull_duration_seconds`)을 본다.
- init 컨테이너가 없는 Pod는 Initialized가 샌드박스 생성보다 먼저 True가 된다(Kubernetes 문서).
