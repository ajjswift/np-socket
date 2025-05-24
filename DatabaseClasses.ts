/* Imports */

import { z } from "zod";
import { Client, Pool, type QueryConfig, type QueryResult } from "pg";

/* Define the database url schema */
const DatabaseUrlSchema = z
    .string({
        required_error: "DATABASE_URL environment variable is required.",
        invalid_type_error:
            "DATABASE_URL environment variable must be a string.",
    })
    .url({
        message: "DATABASE_URL environment variable must be a valid URL.",
    });

/* Define classes */

/**
 * Connects to a database
 * @example
 * ```
 *  const database = new Database(process.env.DATABASE_URL)
 *
 *  // Check that the database is queryable
 *  if (!(await database.isQueryable())) {
 *      throw new Error("An error occurred whilst testing the database");
 *  }
 *
 *  const users = await database.execute`SELECT * from users`
 *
 * ```
 */
class Database {
    #url: z.infer<typeof DatabaseUrlSchema>;
    #pool: Pool;
    commandsExecuted: number = 0;

    constructor(database_url?: z.infer<typeof DatabaseUrlSchema> | undefined) {
        if (global.Database) {
            return global.Database;
        }

        // Set database url from input or environment
        const rawUrl = database_url || process.env.DATABASE_URL; // Revert to process.env.DATABASE_URL if not defined

        // Validate the URL against the schema with Zod
        const validationResult = DatabaseUrlSchema.safeParse(rawUrl);

        if (!validationResult.success) {
            console.error(
                "Database URL validation failed:",
                validationResult.error.flatten()
            );
            throw new Error(
                "Invalid or missing DATABASE_URL environment variable, and failed to pass URL into class"
            );
        }

        this.#url = validationResult.data;
        global.Database = this;

        // Create the pool.
        const pool = new Pool({
            connectionString: this.#url,
        });
        this.#pool = pool;
        console.log("Database pool created successfully.");

        return this;
    }

    async #testPool() {
        // Run a test query to check the connection to the database.
        const testQuery = await this.#pool.query("SELECT 1;");

        if (testQuery.rowCount !== 1) {
            return new Error("Database pool test query failed");
        }

        return true;
    }

    /**
     * Tests the database connection
     *
     * Runs the command "SELECT 1" on the database to test whether it's online and reachable or not.
     * Will log the timings to the console
     *
     * @returns A Promise that resolves either true in the event of a successful query, or false in the event the query fails.
     *
     * @example
     * ```
     * const database = new Database(process.env.DATABASE_URL)
     *
     * if (!(await database.isQueryable())) {
     *      // Database is not queryable
     * }
     * else {
     * // Database is queryable
     * }
     * ```
     */
    async isQueryable() {
        console.time("Testing database");
        const queryable = await this.#testPool();
        console.timeEnd("Testing database");

        if (queryable !== true) {
            console.error(queryable.message);
            return false;
        }
        return true;
    }

    /**
     * Executes a parameterized SQL query using the provided template string and values.
     *
     * This function constructs a SQL query by interpolating the given template
     * string array and the provided values. It manipulates the inputted values to avoid SQL injection.
     *
     * @param strings - A template string array representing the parts of the SQL query.
     *                  This is the first argument passed to a tagged template literal.
     * @returns A Promise that resolves to the result of the SQL query.  The result
     *          format depends on the underlying database driver being used.
     *
     * @example
     * ```typescript
     * const userId = '123';
     * const userName = 'John Doe';
     *
     * const result = await execute`SELECT * FROM users WHERE id = ${userId} AND name = ${userName};`;
     *
     * ```
     */
    async execute(
        strings: TemplateStringsArray,
        ...values: any[]
    ): Promise<Query> {
        let query = "";
        let variables: any[] = [];

        strings.forEach((string, index) => {
            query += string;
            if (index < values.length) {
                query += "$" + (index + 1); // Keep the placeholders in the string
                variables.push(values[index]);
            }
        });

        const queryObj = await new Query(
            query,
            variables,
            this.#pool
        ).execute();
        this.commandsExecuted++;
        return queryObj;
    }
}

/**
 * Represents a database query and its results. A private class only used in the Database class.
 *
 * This class encapsulates a SQL query, its associated variables, and the
 * connection pool used to execute it. It provides methods for executing the
 * query and accessing the results.
 *
 * @example
 * ```typescript
 * const query = new Query("SELECT * FROM users WHERE id = $1", [userId], pool);
 * await query.execute();
 *
 * console.log(query); // Access the query results as an array of objects
 * console.log(query.rows) // does same as above.
 * console.log(query.rowCount); // Get the number of rows returned
 * ```
 */
class Query {
    #query: string;
    #variables: any[];
    #pool: Pool;
    rowCount: Number | null = 0;
    rows: any[] = [];
    command: string = "";
    fields: any = "";
    oid: any = "";
    #error: Error | null = null;

    constructor(query: string, variables: any[], pool: Pool) {
        this.#query = query;
        this.#variables = variables;
        this.#pool = pool;
    }

    async execute(): Promise<this> {
        try {
            const res = await this.#pool.query(this.#query, this.#variables);
            this.rowCount = res?.rowCount;
            this.rows = res?.rows;
            this.command = res?.command;
            this.fields = res?.fields;
            this.oid = res?.oid;
            this.#error = null;
        } catch (error) {
            this.#error =
                error instanceof Error ? error : new Error(String(error));
            console.error(error);
        }
        return this;
    }

    // Property that returns true if the query executed successfully, false otherwise
    get ok(): boolean | Error {
        return this.#error === null ? true : false;
    }

    // Make the object iterable so you can loop through rows
    [Symbol.iterator]() {
        return this.rows[Symbol.iterator]();
    }

    // Custom toString to show rows when logged directly
    toString() {
        return this.#query;
    }

    // Custom inspection for Node.js console.log
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.rows;
    }

    // Allow array-like access to rows
    get length() {
        return this.rows.length;
    }

    // Allow array indexing
    [index: number]: any;
}

export { Database };
