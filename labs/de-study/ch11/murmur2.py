"""Kafka 기본 파티셔너가 키를 파티션에 나눌 때 쓰는 murmur2 해시(org.apache.kafka.common.utils.Utils.murmur2)를 옮긴 것."""


def murmur2(data: bytes) -> int:
    """32비트 부호 없는 정수로 돌려준다."""
    length = len(data)
    seed, m, r = 0x9747B28C, 0x5BD1E995, 24
    h = (seed ^ length) & 0xFFFFFFFF
    for i in range(length // 4):
        j = i * 4
        k = data[j] | (data[j + 1] << 8) | (data[j + 2] << 16) | (data[j + 3] << 24)
        k = (k * m) & 0xFFFFFFFF
        k ^= k >> r
        k = (k * m) & 0xFFFFFFFF
        h = (h * m) & 0xFFFFFFFF
        h ^= k
    rest, tail = length % 4, length & ~3
    if rest == 3:
        h ^= data[tail + 2] << 16
    if rest >= 2:
        h ^= data[tail + 1] << 8
    if rest >= 1:
        h ^= data[tail]
        h = (h * m) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * m) & 0xFFFFFFFF
    h ^= h >> 15
    return h


def partition_for(key: str, num_partitions: int) -> int:
    """BuiltInPartitioner.partitionForKey: toPositive(murmur2(key)) % numPartitions"""
    return (murmur2(key.encode()) & 0x7FFFFFFF) % num_partitions


def as_java_int(u: int) -> int:
    return u - (1 << 32) if u >= 1 << 31 else u


if __name__ == "__main__":
    for s in ["abc", "21", "foobar", "a-little-bit-long-string", "a-little-bit-longer-string", "lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8"]:
        print(f"{s!r:<55} {as_java_int(murmur2(s.encode()))}")
