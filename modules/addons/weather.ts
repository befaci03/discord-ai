/// Addon: weather
/// Gives the agent weather capabilities via Open-Meteo (free, no API key):
/// current conditions and multi-day forecasts, read-only.

import { isHostAllowed } from "../../src/utils/toolang/netguard.js";
import { Addon, AgentFunction } from "../../src/modules/types.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 500_000;

async function getJson(url: URL): Promise<unknown> {
	if (!isHostAllowed(url.hostname, { blockPrivate: true })) throw new Error("weather: host blocked by policy");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const resp = await fetch(url, { signal: controller.signal, redirect: "error" });
		if (!resp.ok) throw new Error(`weather: HTTP ${resp.status}`);
		const text = await resp.text();
		if (text.length > MAX_RESPONSE_BYTES) throw new Error("weather: response too large");
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

async function geocode(place: unknown): Promise<{ lat: number; lon: number; name: string; country: string }> {
	const q = String(place ?? "").trim();
	if (q.length === 0 || q.length > 100) throw new Error("invalid place name (max 100 chars)");
	const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
	url.searchParams.set("name", q);
	url.searchParams.set("count", "1");
	url.searchParams.set("language", "en");
	const data = (await getJson(url)) as { results?: { latitude: number; longitude: number; name: string; country?: string }[] };
	const hit = data.results?.[0];
	if (!hit) throw new Error(`no place found for '${q}'`);
	return { lat: hit.latitude, lon: hit.longitude, name: hit.name, country: hit.country ?? "" };
}

async function current(place: unknown): Promise<unknown> {
	const geo = await geocode(place);
	const url = new URL("https://api.open-meteo.com/v1/forecast");
	url.searchParams.set("latitude", String(geo.lat));
	url.searchParams.set("longitude", String(geo.lon));
	url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m");
	const data = (await getJson(url)) as { current?: Record<string, unknown> };
	return { place: `${geo.name}, ${geo.country}`, ...(data.current ?? {}) };
}

async function forecast(place: unknown, days: unknown): Promise<unknown> {
	const n = Math.min(Math.max(Number(days ?? 3) || 3, 1), 7);
	const geo = await geocode(place);
	const url = new URL("https://api.open-meteo.com/v1/forecast");
	url.searchParams.set("latitude", String(geo.lat));
	url.searchParams.set("longitude", String(geo.lon));
	url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
	url.searchParams.set("forecast_days", String(n));
	const data = (await getJson(url)) as { daily?: Record<string, unknown> };
	return { place: `${geo.name}, ${geo.country}`, ...(data.daily ?? {}) };
}

function fn(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	execute: (args: Record<string, unknown>) => Promise<unknown>,
): AgentFunction {
	return { name, description, parameters, execute, dangerous: false };
}

export const Weather: Addon = {
	name: "weather",
	description: "Weather lookups for the agent via Open-Meteo (no API key needed)",
	functions: [], // built in init()
	init: () => {
		Weather.functions = [
			fn("weather_now", "Get current weather (temperature, humidity, wind) for a city.", { type: "object", properties: { place: { type: "string", description: "City name, e.g. 'Paris'" } }, required: ["place"] }, (a) => current(a.place)),
			fn("weather_forecast", "Get a daily weather forecast (1-7 days) for a city.", { type: "object", properties: { place: { type: "string", description: "City name" }, days: { type: "number", description: "1-7, default 3" } }, required: ["place"] }, (a) => forecast(a.place, a.days)),
		];
		return true; // no configuration needed
	},
};
