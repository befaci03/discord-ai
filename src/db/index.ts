import SQLite from "./sqlite.js";
import PostgreSQLDB from "./postgresql.js";
import { MariaDB } from "./mariadb.js";
import MongoDB from "./mongodb.js";
import { CassandraDB } from "./cassandra.js";
import { AppConfig } from "../utils/config.js";

const ALLOWED = ["sqlite", "postgresql", "mariadb", "mongodb", "cassandra"] as const;
type Driver = (typeof ALLOWED)[number];

export function createDB(config: AppConfig): SQLite | PostgreSQLDB | MariaDB | MongoDB | CassandraDB {
	const driver = (config.database.use ?? "sqlite") as Driver;

	if (!ALLOWED.includes(driver)) {
		console.warn(`[database] unknown driver '${driver}', defaulting to sqlite`);
		return new SQLite((config.database.sqlite as { path?: string } | undefined)?.path ?? "./modules/data.sqlite");
	}

	const db = config.database;
	switch (driver) {
		case "sqlite": {
			const sqlite = db.sqlite as { path?: string } | undefined;
			return new SQLite(sqlite?.path ?? "./modules/data.sqlite");
		}
		case "postgresql": {
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
			const m = db.mongodb as { uri?: string; database?: string } | undefined;
			if (!m?.uri || !m?.database) {
				console.warn(`[database] mongodb driver needs uri + database, got ${JSON.stringify(m)}`);
			}
			return new MongoDB(m?.uri ?? "mongodb://127.0.0.1:27017", m?.database ?? "discord_ai");
		}
		case "cassandra": {
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
			return new SQLite("./modules/data.sqlite");
	}
}
