// redis.js
import Redis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const { REDIS_URL = "redis://localhost:6379" } = process.env;


// Create Redis instance
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on("error", (error) => {
  console.error("Redis connection error:", error);
});

redis.on("connect", () => {
  console.log("Connected to Redis successfully");
});

/**
 * Get a value from Redis
 * @param {string} key - The key to get
 * @returns {Promise<any>} The value (automatically JSON parsed if object)
 */
async function get(key) {
  const value = await redis.get(key);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Set a value in Redis
 * @param {string} key - The key to set
 * @param {any} value - The value to set (automatically JSON stringified if object)
 * @param {number} [expiry] - Expiry time in seconds (optional)
 * @returns {Promise<string>} "OK" if successful
 */
async function set(key, value, expiry = null) {
  const stringValue = typeof value === "object" ? JSON.stringify(value) : value;
  if (expiry) {
    return redis.setex(key, expiry, stringValue);
  }
  return redis.set(key, stringValue);
}

/**
 * Delete a key from Redis
 * @param {string} key - The key to delete
 * @returns {Promise<number>} Number of keys deleted
 */
async function del(key) {
  return redis.del(key);
}

/**
 * Check if a key exists
 * @param {string} key - The key to check
 * @returns {Promise<boolean>} True if key exists
 */
async function exists(key) {
  const result = await redis.exists(key);
  return result === 1;
}

/**
 * Set a value with expiry if it doesn't exist
 * @param {string} key - The key to set
 * @param {any} value - The value to set
 * @param {number} expiry - Expiry time in seconds
 * @returns {Promise<boolean>} True if key was set
 */
async function setNX(key, value, expiry) {
  const stringValue = typeof value === "object" ? JSON.stringify(value) : value;
  const result = await redis.set(key, stringValue, "EX", expiry, "NX");
  return result === "OK";
}

/**
 * Increment a key
 * @param {string} key - The key to increment
 * @returns {Promise<number>} The new value
 */
async function incr(key) {
  return redis.incr(key);
}

/**
 * Add members to a set
 * @param {string} key - The set key
 * @param {...string} members - Members to add
 * @returns {Promise<number>} Number of members added
 */
async function sadd(key, ...members) {
  return redis.sadd(key, ...members);
}

/**
 * Get all members of a set
 * @param {string} key - The set key
 * @returns {Promise<string[]>} Array of set members
 */
async function smembers(key) {
  return redis.smembers(key);
}

/**
 * Store value in a hash field
 * @param {string} key - The hash key
 * @param {string} field - The field to set
 * @param {any} value - The value to set
 * @returns {Promise<number>} 1 if field is new, 0 if field was updated
 */
async function hset(key, field, value) {
  const stringValue = typeof value === "object" ? JSON.stringify(value) : value;
  return redis.hset(key, field, stringValue);
}

/**
 * Get value from a hash field
 * @param {string} key - The hash key
 * @param {string} field - The field to get
 * @returns {Promise<any>} The value
 */
async function hget(key, field) {
  const value = await redis.hget(key, field);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Get all fields and values from a hash
 * @param {string} key - The hash key
 * @returns {Promise<Object>} Object with all fields and values
 */
async function hgetall(key) {
  const hash = await redis.hgetall(key);
  const result = {};

  for (const [field, value] of Object.entries(hash)) {
    try {
      result[field] = JSON.parse(value);
    } catch {
      result[field] = value;
    }
  }

  return result;
}

/**
 * Add a member with score to a sorted set
 * @param {string} key - The sorted set key
 * @param {number} score - The score
 * @param {string} member - The member
 * @returns {Promise<number>} Number of elements added
 */
async function zadd(key, score, member) {
  return redis.zadd(key, score, member);
}

/**
 * Get range of members from sorted set
 * @param {string} key - The sorted set key
 * @param {number} start - Start index
 * @param {number} stop - Stop index
 * @returns {Promise<string[]>} Array of members
 */
async function zrange(key, start, stop) {
  return redis.zrange(key, start, stop);
}

export {
  redis, // Export raw client for advanced usage
  get,
  set,
  del,
  exists,
  setNX,
  incr,
  sadd,
  smembers,
  hset,
  hget,
  hgetall,
  zadd,
  zrange,
};
