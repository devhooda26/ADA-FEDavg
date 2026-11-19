FROM node:22-bookworm-slim
ENV NODE_ENV=production PYTHON=/opt/venv/bin/python PORT=4000
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates tini \
 && python3 -m venv /opt/venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY ml/requirements.txt ml/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r ml/requirements.txt
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chmod +x scripts/*.sh docker-entrypoint.sh && mkdir -p data && chown -R node:node /app/data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--","./docker-entrypoint.sh"]
