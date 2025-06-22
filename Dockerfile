# 使用官方 Node.js 16 Alpine 基础镜像
FROM node:16-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统依赖
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && ln -sf python3 /usr/bin/python

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install && npm cache clean --force

# 拷贝源码
COPY . .

# 构建项目
RUN npm run build

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 更改文件所有权
RUN chown -R nodejs:nodejs /app
USER nodejs

# 设置环境变量
ENV NODE_ENV=production

# 启动命令
CMD ["node", "build/index.js"]
