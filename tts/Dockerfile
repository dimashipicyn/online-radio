FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV TTS_PORT=8001 MODEL_PATH=/cache/v4_ru.pt
VOLUME ["/cache"]
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=20 \
  CMD python -c "import urllib.request,json;assert json.load(urllib.request.urlopen('http://localhost:8001/health',timeout=4))['ready']"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
