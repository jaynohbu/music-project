FROM public.ecr.aws/lambda/nodejs:22
RUN dnf install -y python3.11 python3.11-pip && dnf clean all \
    && LD_LIBRARY_PATH="" python3.11 -m pip install --no-cache-dir "yt-dlp[default]==2026.10.26"
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --omit=dev
COPY *.mjs ${LAMBDA_TASK_ROOT}/
CMD ["worker.handler"]
