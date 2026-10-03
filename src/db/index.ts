// DB factory. Drivers are imported lazily (dynamic import) so the process
// only loads the one the config selects: faster startup, smaller attack
// surface, and a driver this runtime cannot load only affects configs that
// actually use it.

import { AppConfig } from "../utils/config.js";
import type SQLite from "./sqlite.js";
import type PostgreSQLDB from "./postgresql.js";
import type { MariaDB } from "./mariadb.js";
import type MongoDB from "./mongodb.js";
import type { CassandraDB } from "./cassandra.js";

const ALLOWED = ["sqlite", "postgresql", "mariadb", "mongodb", "cassandra"] as const;
type Driver = (typeof ALLOWED)[number];

async function openSQLite(config: AppConfig): Promise<SQLite> {
	const { default: SQLite } = await import("./sqlite.js");
	const file = (config.database.sqlite as { path?: string } | undefined)?.path ?? "./modules/data.sqlite";
	return new SQLite(file);
}

export async function createDB(config: AppConfig): Promise<SQLite | PostgreSQLDB | MariaDB | MongoDB | CassandraDB> {
	const driver = (config.database.use ?? "sqlite") as Driver;

	if (!ALLOWED.includes(driver)) {
		console.warn(`[database] unknown driver '${driver}', defaulting to sqlite`);
		return openSQLite(config);
	}

	const db = config.database;
	switch (driver) {
		case "sqlite": {
			return openSQLite(config);
		}
		case "postgresql": {
			const { default: PostgreSQLDB } = await import("./postgresql.js");
			const p = db.postgres as { host?: string; port?: number; username?: string; password?: string; database?: string } | undefined;
			return new PostgreSQLDB({
				host: p?.host ?? "127.0.0.1",
				port: p?.port ?? 5432,
				user: p?.username ?? "",
				password: p?.password ?? "",
				database: p?.database ?? "discord_ai",
			});
		}
		case "mariadb": {
			const { MariaDB } = await import("./mariadb.js");
			const m = db.mariadb as { host?: string; port?: number; username?: string; password?: string; database?: string } | undefined;
			return new MariaDB({
				host: m?.host ?? "127.0.0.1",
				port: m?.port ?? 3306,
				user: m?.username ?? "",
				password: m?.password ?? "",
				database: m?.database ?? "discord_ai",
			});
		}
		case "mongodb": {
			const { default: MongoDB } = await import("./mongodb.js");
			const m = db.mongodb as { uri?: string; database?: string } | undefined;
			if (!m?.uri || !m?.database) {
				console.warn(`[database] mongodb driver needs uri + database, got ${JSON.stringify(m)}`);
			}
			return new MongoDB(m?.uri ?? "mongodb://127.0.0.1:27017", m?.database ?? "discord_ai");
		}
		case "cassandra": {
			const { CassandraDB } = await import("./cassandra.js");
			const c = db.cassandra as { contact_points?: string[]; local_datacenter?: string; keyspace?: string } | undefined;
			if (!c?.contact_points?.length || !c.keyspace) {
				console.warn(`[database] cassandra driver needs contact_points + keyspace, got ${JSON.stringify(c)}`);
			}
			return new CassandraDB({
				contact_points: c?.contact_points ?? ["127.0.0.1"],
				local_datacenter: c?.local_datacenter ?? "datacenter1",
				keyspace: c?.keyspace ?? "discord_ai",
			});
		}
		default:
			return openSQLite(config);
	}
}
