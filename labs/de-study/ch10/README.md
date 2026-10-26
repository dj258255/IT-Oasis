# DE 공부 11편 실습: Mosquitto로 와일드카드, retained, 세션, QoS 낮추기 보기

Docker가 필요하다. 아직 직접 돌려 결과를 기록하지 않았다.

```bash
docker run -d --name mqtt -p 1883:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
alias sub='docker exec -i mqtt mosquitto_sub'
alias pub='docker exec -i mqtt mosquitto_pub'
```

## 1. 와일드카드

```bash
sub -t 'rider/+/location' -v &          # 라이더 아무나, 한 단계
sub -t 'rider/#' -v &                   # rider 아래 전부(그리고 rider 자신)
pub -t rider/42/location -m '37.50,127.03'
pub -t rider/42/status -m 'delivering'  # 첫 구독에는 안 오고 두 번째 구독에만 온다
```

## 2. retained 메시지

```bash
pub -r -t store/7/status -m open        # retained로 발행
sub -t store/7/status -v -C 1           # 나중에 구독해도 바로 open을 받는다
pub -r -n -t store/7/status             # 빈 payload retained로 지운다
sub -t store/7/status -v -W 2           # 이제는 아무것도 안 온다(2초 뒤 종료)
```

## 3. 세션: 끊겨 있는 동안의 메시지

```bash
# MQTT 5, Clean Start 0, 세션 만료 1시간, QoS 1 구독. 한 번 붙었다 바로 끊는다
sub -V mqttv5 -c -x 3600 -i app-1 -q 1 -t 'order/#' -v -W 1
pub -q 1 -t order/1001 -m 'paid'        # app-1이 끊겨 있는 동안 발행
sub -V mqttv5 -c -x 3600 -i app-1 -q 1 -t 'order/#' -v -W 2   # 다시 붙으면 paid를 받는다
```

같은 실험을 `-c` 없이(Clean Start 1) 하면 다시 붙어도 받지 못한다.

## 4. QoS는 낮은 쪽으로

```bash
sub -q 0 -t qos/test -F '%q %t %p' &   # %q: 받은 메시지의 QoS
pub -q 2 -t qos/test -m hello          # 2로 보내도 구독이 0이면 0으로 받는다
```

정리: `docker rm -f mqtt`
