FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /svc
RUN pip install --no-cache-dir "faster-whisper>=1.0.3" "fastapi>=0.110" "uvicorn>=0.29"
COPY app.py .
ENV HF_HOME=/models
EXPOSE 9000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000", "--workers", "1"]
