FROM python:3.12-slim
RUN pip install --no-cache-dir openai psycopg2-binary
WORKDIR /app
COPY apps/gateway/scripts/*.py /app/
