# Build context is the repository ROOT, not this directory: the image installs
# obstack-py from packages/, which is above here.
#
#   docker build -f demo/sdk-sample-py/Dockerfile -t obstack-sdk-sample-py .
#
FROM python:3.14.7-slim

# Unbuffered stdout so `docker compose logs -f` is live, and no .pyc writing into
# a layer nobody reads.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# The install is the two commands README.md gives a human, in that order and
# with the same arguments — an image built from a different install would prove
# something the runbook does not say.
COPY packages/obstack-py ./packages/obstack-py
COPY demo/sdk-sample-py/requirements.txt ./
RUN pip install --no-cache-dir './packages/obstack-py[fastapi]' \
 && pip install --no-cache-dir -r requirements.txt \
 && rm -rf ./packages

COPY demo/sdk-sample-py/*.py ./

RUN useradd --create-home --uid 10001 sample
USER sample

EXPOSE 8010
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8010"]
