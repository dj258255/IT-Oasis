import random
import time
from datetime import datetime, timedelta

from airflow.sdk import dag, task


@dag(
    schedule="*/5 * * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    default_args={"retries": 2, "retry_delay": timedelta(seconds=10)},
)
def shop_daily_sales():
    @task
    def extract_orders():
        time.sleep(5)
        return "/tmp/orders.jsonl"          # 데이터 대신 경로만 넘긴다

    @task
    def clean(path):
        if random.random() < 0.5:
            raise RuntimeError("일시 오류 흉내")   # 절반은 실패해서 재시도를 탄다
        return path.replace("orders", "orders_clean")

    @task
    def daily_sales(path):
        time.sleep(60)                      # 실행 도중 끄기 실험용으로 길게
        print("집계 완료", path)

    daily_sales(clean(extract_orders()))


shop_daily_sales()
