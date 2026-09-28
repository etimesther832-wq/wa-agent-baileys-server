# Use Node.js 20 as base image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application files
COPY server.js .

# Create persistent volume directory for WhatsApp sessions
RUN mkdir -p /app/sessions

VOLUME ["/app/sessions"]

# Expose the application port (Blitz will map this internally)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the application
CMD ["npm", "start"]
