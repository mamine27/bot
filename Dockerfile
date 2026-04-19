# Use the official Node.js 18 image
FROM node:18-slim

# Create and define the application directory
WORKDIR /usr/src/app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Start the bot
CMD ["node", "index.js"]
