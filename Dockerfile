# ==============================================================================
# Dockerfile for Plan Batch to Picking
# Provides:
#  - Node.js 20 runtime (Frontend on port 9999, Backend API on port 8888)
#  - Python 3 with openpyxl (for Excel report generation)
# ==============================================================================

FROM node:20-slim
LABEL maintainer="Plan Batch to Picking System"

# 1. ติดตั้ง Python 3, openpyxl, และ curl สำหรับ Excel generation และ Health check
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-openpyxl curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. คัดลอก package.json และติดตั้ง Backend Dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=optional

# 3. คัดลอกโค้ด Backend ทั้งหมด
COPY backend/ ./backend/

# 4. คัดลอกไฟล์คอมไพล์ Frontend (Angular build output)
COPY dist/ ./dist/

# 5. กำหนด Environment Variables เริ่มต้น
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8888 \
    BACKEND_PORT=8888 \
    FRONTEND_PORT=9999 \
    TZ=Asia/Bangkok

# 6. เปิดพอร์ตการทำงาน
# - 9999: Frontend Web App + Integrated /api
# - 8888: Dedicated Backend API Service
EXPOSE 9999 8888

# 7. สลับโฟลเดอร์ทำงานไปที่ backend และสั่งรัน server.ts
WORKDIR /app/backend
CMD ["npx", "tsx", "src/server.ts"]
