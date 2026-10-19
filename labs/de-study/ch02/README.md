# Ch-02 실습: airflow standalone으로 재시도와 메타DB 보기

쿠버네티스 없이 맥에서 Airflow 3.2.2를 띄우고 `dags/shop_daily_sales.py`를 돌린다.

```bash
python3.12 -m venv .venv
.venv/bin/pip install "apache-airflow==3.2.2" \
  --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-3.2.2/constraints-3.12.txt"

export AIRFLOW_HOME="$PWD/airflow"
export AIRFLOW__CORE__LOAD_EXAMPLES=False
export AIRFLOW__CORE__DAGS_FOLDER="$PWD/dags"
export AIRFLOW__SCHEDULER__TASK_INSTANCE_HEARTBEAT_TIMEOUT=60   # 도중에 끄는 실험을 빨리 보려고 줄인다

.venv/bin/airflow standalone     # 터미널에 admin 비밀번호가 찍힌다. http://localhost:8080
```

- constraints 주소의 `3.12`는 실제 Python 버전과 맞춘다. Airflow 3.2는 3.10~3.14를 지원한다.
- 메타DB 위치는 `.venv/bin/airflow config get-value database sql_alchemy_conn`으로 확인한다.

해 볼 것

1. UI에서 DAG를 켜고 실행한다. `clean`이 절반 확률로 실패하고 10초 뒤 다시 시도하는 것을 Graph에서 본다.
2. 메타DB를 직접 연다(SQLite라면).
   ```bash
   sqlite3 airflow/airflow.db \
     "select dag_id, run_id, state from dag_run;" \
     "select task_id, state, try_number from task_instance order by start_date;" \
     "select task_id, key from xcom;"
   ```
3. `daily_sales`가 60초 동안 도는 도중에 `airflow standalone`을 Ctrl+C로 끄고 다시 켠다. 끄기 전에 그 태스크가 어떤 상태가 될지 적어 두고 비교한다.

이 실습은 아직 직접 돌려 결과를 기록하지 않았다. 돌리면 결과를 이 README와 글에 채운다.
