import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const API_BASE = 'https://api.jolpi.ca/ergast/f1';
const LATEST_COMPLETE_SEASON = '2025'; // Season with complete standings

// ERC-8004 Agent Metadata
const AGENT_METADATA = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'F1 Racing Agent',
  description: 'Real-time Formula 1 racing data - schedules, standings, drivers, circuits, and race results via x402 micropayments.',
  services: [
    { name: 'x402', endpoint: 'https://f1-racing-agent-production.up.railway.app' },
    { name: 'github', endpoint: 'https://github.com/langoustine69/f1-racing-agent' },
  ],
  capabilities: [
    { name: 'overview', description: 'Free F1 season overview' },
    { name: 'driver', description: 'Driver lookup by ID' },
    { name: 'standings', description: 'Full championship standings' },
    { name: 'schedule', description: 'Race schedule with sessions' },
    { name: 'results', description: 'Detailed race results' },
    { name: 'report', description: 'Comprehensive F1 report' },
  ],
  active: true,
  registeredOn: 'ethereum:1',
  wallet: '0x0C3D21e8835990427405F6FeA649f1fb8CB30ED6',
};

const agent = await createAgent({
  name: 'f1-racing-agent',
  version: '1.0.0',
  description: 'Real-time Formula 1 racing data - schedules, standings, drivers, circuits, and race results. Powered by live F1 data.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// Serve ERC-8004 metadata (must be added after createAgentApp but works with Hono)
app.get('/.well-known/agent-metadata.json', (c) => {
  c.header('Content-Type', 'application/json');
  return c.json(AGENT_METADATA);
});

// Also add at /agent-metadata.json as fallback
app.get('/agent-metadata.json', (c) => {
  c.header('Content-Type', 'application/json');
  return c.json(AGENT_METADATA);
});

// === HELPER: Fetch JSON from Ergast API ===
async function fetchF1(path: string) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`F1 API error: ${response.status}`);
  return response.json();
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of F1 season - top 3 drivers and constructors standings, plus next race',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [driverData, constructorData, scheduleData] = await Promise.all([
      fetchF1(`/${LATEST_COMPLETE_SEASON}/driverStandings.json`),
      fetchF1(`/${LATEST_COMPLETE_SEASON}/constructorStandings.json`),
      fetchF1('/current.json'),
    ]);

    const driverStandings = driverData.MRData.StandingsTable.StandingsLists[0]?.DriverStandings || [];
    const constructorStandings = constructorData.MRData.StandingsTable.StandingsLists[0]?.ConstructorStandings || [];
    const races = scheduleData.MRData.RaceTable.Races || [];
    const now = new Date();
    const nextRace = races.find((r: any) => new Date(r.date) > now);

    return {
      output: {
        championshipSeason: LATEST_COMPLETE_SEASON,
        topDrivers: driverStandings.slice(0, 3).map((d: any) => ({
          position: d.position,
          name: `${d.Driver.givenName} ${d.Driver.familyName}`,
          team: d.Constructors[0]?.name,
          points: d.points,
          wins: d.wins,
        })),
        topConstructors: constructorStandings.slice(0, 3).map((c: any) => ({
          position: c.position,
          name: c.Constructor.name,
          points: c.points,
          wins: c.wins,
        })),
        nextRace: nextRace ? {
          name: nextRace.raceName,
          circuit: nextRace.Circuit.circuitName,
          location: `${nextRace.Circuit.Location.locality}, ${nextRace.Circuit.Location.country}`,
          date: nextRace.date,
        } : null,
        fetchedAt: new Date().toISOString(),
        dataSource: 'Jolpica Ergast F1 API (live)',
      },
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Driver Lookup ===
addEntrypoint({
  key: 'driver',
  description: 'Look up a specific F1 driver by ID (e.g., max_verstappen, norris, hamilton)',
  input: z.object({ 
    driverId: z.string().describe('Driver ID (e.g., max_verstappen, norris, hamilton, leclerc)')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const driverInfo = await fetchF1(`/drivers/${ctx.input.driverId}.json`);
    const driver = driverInfo.MRData.DriverTable.Drivers[0];
    
    if (!driver) {
      return { output: { error: 'Driver not found', driverId: ctx.input.driverId } };
    }

    // Get latest season results for this driver
    const resultsData = await fetchF1(`/${LATEST_COMPLETE_SEASON}/drivers/${ctx.input.driverId}/results.json`);
    const races = resultsData.MRData.RaceTable.Races || [];

    return {
      output: {
        driver: {
          id: driver.driverId,
          name: `${driver.givenName} ${driver.familyName}`,
          code: driver.code,
          number: driver.permanentNumber,
          nationality: driver.nationality,
          dateOfBirth: driver.dateOfBirth,
          wikipedia: driver.url,
        },
        season: LATEST_COMPLETE_SEASON,
        seasonResults: {
          races: races.length,
          results: races.slice(-5).map((r: any) => ({
            race: r.raceName,
            position: r.Results[0]?.position,
            points: r.Results[0]?.points,
            team: r.Results[0]?.Constructor?.name,
          })),
        },
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2 ($0.002): Full Standings ===
addEntrypoint({
  key: 'standings',
  description: 'Full driver and constructor standings for specified season',
  input: z.object({
    season: z.string().optional().default(LATEST_COMPLETE_SEASON).describe('Season year (e.g., 2025, 2024)'),
    type: z.enum(['drivers', 'constructors', 'both']).optional().default('both'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const season = ctx.input.season;
    const result: any = { season, fetchedAt: new Date().toISOString() };

    if (ctx.input.type === 'drivers' || ctx.input.type === 'both') {
      const driverData = await fetchF1(`/${season}/driverStandings.json`);
      const standings = driverData.MRData.StandingsTable.StandingsLists[0];
      result.driverStandings = standings?.DriverStandings?.map((d: any) => ({
        position: parseInt(d.position),
        driver: `${d.Driver.givenName} ${d.Driver.familyName}`,
        code: d.Driver.code,
        team: d.Constructors[0]?.name,
        points: parseFloat(d.points),
        wins: parseInt(d.wins),
      })) || [];
    }

    if (ctx.input.type === 'constructors' || ctx.input.type === 'both') {
      const constructorData = await fetchF1(`/${season}/constructorStandings.json`);
      const standings = constructorData.MRData.StandingsTable.StandingsLists[0];
      result.constructorStandings = standings?.ConstructorStandings?.map((c: any) => ({
        position: parseInt(c.position),
        team: c.Constructor.name,
        nationality: c.Constructor.nationality,
        points: parseFloat(c.points),
        wins: parseInt(c.wins),
      })) || [];
    }

    return { output: result };
  },
});

// === PAID ENDPOINT 3 ($0.002): Race Schedule ===
addEntrypoint({
  key: 'schedule',
  description: 'F1 race schedule with dates, circuits, and session times',
  input: z.object({
    season: z.string().optional().default('current').describe('Season year or "current" for upcoming'),
    upcoming: z.boolean().optional().default(false).describe('Only show upcoming races'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchF1(`/${ctx.input.season}.json`);
    const races = data.MRData.RaceTable.Races || [];
    const now = new Date();

    let filtered = races;
    if (ctx.input.upcoming) {
      filtered = races.filter((r: any) => new Date(r.date) > now);
    }

    return {
      output: {
        season: data.MRData.RaceTable.season,
        totalRaces: races.length,
        races: filtered.map((r: any) => ({
          round: parseInt(r.round),
          name: r.raceName,
          circuit: r.Circuit.circuitName,
          location: `${r.Circuit.Location.locality}, ${r.Circuit.Location.country}`,
          date: r.date,
          time: r.time,
          sessions: {
            practice1: r.FirstPractice ? `${r.FirstPractice.date} ${r.FirstPractice.time}` : null,
            practice2: r.SecondPractice ? `${r.SecondPractice.date} ${r.SecondPractice.time}` : null,
            practice3: r.ThirdPractice ? `${r.ThirdPractice.date} ${r.ThirdPractice.time}` : null,
            qualifying: r.Qualifying ? `${r.Qualifying.date} ${r.Qualifying.time}` : null,
            sprint: r.Sprint ? `${r.Sprint.date} ${r.Sprint.time}` : null,
          },
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4 ($0.003): Race Results ===
addEntrypoint({
  key: 'results',
  description: 'Detailed race results with positions, times, and lap data',
  input: z.object({
    season: z.string().optional().default(LATEST_COMPLETE_SEASON).describe('Season year'),
    round: z.string().optional().default('last').describe('Round number or "last"'),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const data = await fetchF1(`/${ctx.input.season}/${ctx.input.round}/results.json`);
    const race = data.MRData.RaceTable.Races[0];

    if (!race) {
      return { output: { error: 'Race not found', season: ctx.input.season, round: ctx.input.round } };
    }

    return {
      output: {
        race: {
          season: race.season,
          round: parseInt(race.round),
          name: race.raceName,
          circuit: race.Circuit.circuitName,
          date: race.date,
          wikipedia: race.url,
        },
        results: race.Results.map((r: any) => ({
          position: parseInt(r.position),
          driver: `${r.Driver.givenName} ${r.Driver.familyName}`,
          code: r.Driver.code,
          team: r.Constructor.name,
          laps: parseInt(r.laps),
          time: r.Time?.time || r.status,
          status: r.status,
          points: parseFloat(r.points),
          grid: parseInt(r.grid),
          fastestLap: r.FastestLap ? {
            rank: r.FastestLap.rank,
            lap: r.FastestLap.lap,
            time: r.FastestLap.Time?.time,
            avgSpeed: r.FastestLap.AverageSpeed?.speed,
          } : null,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5 ($0.005): Full Report ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive F1 report - standings, upcoming races, and recent results',
  input: z.object({}),
  price: { amount: 5000 },
  handler: async () => {
    const [scheduleData, driverData, constructorData, lastRaceData] = await Promise.all([
      fetchF1('/current.json'),
      fetchF1(`/${LATEST_COMPLETE_SEASON}/driverStandings.json`),
      fetchF1(`/${LATEST_COMPLETE_SEASON}/constructorStandings.json`),
      fetchF1(`/${LATEST_COMPLETE_SEASON}/last/results.json`),
    ]);

    const races = scheduleData.MRData.RaceTable.Races || [];
    const now = new Date();
    const upcomingRaces = races.filter((r: any) => new Date(r.date) > now).slice(0, 3);
    const driverStandings = driverData.MRData.StandingsTable.StandingsLists[0]?.DriverStandings || [];
    const constructorStandings = constructorData.MRData.StandingsTable.StandingsLists[0]?.ConstructorStandings || [];
    const lastRace = lastRaceData.MRData.RaceTable.Races[0];

    return {
      output: {
        upcomingSeason: scheduleData.MRData.RaceTable.season,
        championshipSeason: LATEST_COMPLETE_SEASON,
        championship: {
          drivers: driverStandings.slice(0, 10).map((d: any) => ({
            pos: d.position,
            name: `${d.Driver.givenName} ${d.Driver.familyName}`,
            team: d.Constructors[0]?.name,
            pts: d.points,
            wins: d.wins,
          })),
          constructors: constructorStandings.map((c: any) => ({
            pos: c.position,
            team: c.Constructor.name,
            pts: c.points,
            wins: c.wins,
          })),
        },
        lastRace: lastRace ? {
          name: lastRace.raceName,
          date: lastRace.date,
          circuit: lastRace.Circuit.circuitName,
          podium: lastRace.Results.slice(0, 3).map((r: any) => ({
            pos: r.position,
            driver: `${r.Driver.givenName} ${r.Driver.familyName}`,
            team: r.Constructor.name,
            time: r.Time?.time || r.status,
          })),
        } : null,
        upcomingRaces: upcomingRaces.map((r: any) => ({
          round: r.round,
          name: r.raceName,
          circuit: r.Circuit.circuitName,
          location: `${r.Circuit.Location.locality}, ${r.Circuit.Location.country}`,
          date: r.date,
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'Jolpica Ergast F1 API',
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🏎️ F1 Racing Agent running on port ${port}`);

export default { port, fetch: app.fetch };
