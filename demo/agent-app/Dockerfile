# Build context is demo/agent-app.
FROM python:3.14.7-slim

# Unbuffered stdout so `docker compose logs -f demo` is live, and no .pyc
# writing into a layer nobody reads.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

RUN useradd --create-home --uid 10001 demo
USER demo

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
