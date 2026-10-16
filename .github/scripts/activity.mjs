import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com/graphql';
const TOP_LANGUAGES = 6;
const FALLBACK_COLOR = '#8B949E';

const REPOS_QUERY = `query($login: String!, $cursor: String) {
  user(login: $login) {
    createdAt
    pullRequests { totalCount }
    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        isPrivate
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const CALENDAR_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function graphql(token, query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-activity-card',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

async function fetchRepositories(token, login) {
  const repos = [];
  let cursor = null;
  let user;
  do {
    ({ user } = await graphql(token, REPOS_QUERY, { login, cursor }));
    if (!user) throw new Error(`User ${login} not found`);
    repos.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (cursor);
  return { createdAt: user.createdAt, pullRequests: user.pullRequests.totalCount, repos };
}

async function fetchContributionDays(token, login, createdAt, now) {
  const days = new Map();
  for (let year = new Date(createdAt).getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const from = new Date(Math.max(Date.UTC(year, 0, 1), Date.parse(createdAt)));
    const to = new Date(Math.min(Date.UTC(year, 11, 31, 23, 59, 59), now.getTime()));
    const { user } = await graphql(token, CALENDAR_QUERY, { login, from: from.toISOString(), to: to.toISOString() });
    for (const week of user.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) days.set(day.date, day.contributionCount);
    }
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

export function summarize({ createdAt, pullRequests, repos }, days, now) {
  const total = days.reduce((sum, d) => sum + d.count, 0);

  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null };
  for (const day of days) {
    if (day.count > 0) {
      run = { length: run.length + 1, start: run.length ? run.start : day.date };
      if (run.length > longest.length) longest = { length: run.length, start: run.start, end: day.date };
    } else {
      run = { length: 0, start: null };
    }
  }

  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  const currentEnd = i >= 0 ? days[i].date : null;
  let currentLength = 0;
  while (i >= 0 && days[i].count > 0) {
    currentLength++;
    i--;
  }
  const current = { length: currentLength, start: currentLength ? days[i + 1].date : null, end: currentLength ? currentEnd : null };

  const sizes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const entry = sizes.get(node.name) ?? { name: node.name, color: node.color ?? FALLBACK_COLOR, size: 0 };
      entry.size += size;
      sizes.set(node.name, entry);
    }
  }
  const ranked = [...sizes.values()].sort((a, b) => b.size - a.size);
  const languageTotal = ranked.reduce((sum, l) => sum + l.size, 0) || 1;
  const top = ranked.slice(0, TOP_LANGUAGES);
  const otherSize = ranked.slice(TOP_LANGUAGES).reduce((sum, l) => sum + l.size, 0);
  if (otherSize > 0) top.push({ name: 'Other', color: FALLBACK_COLOR, size: otherSize });
  const languages = top.map((l) => ({ ...l, share: l.size / languageTotal }));

  return {
    since: new Date(createdAt).getUTCFullYear(),
    total,
    current,
    longest,
    stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    pullRequests,
    publicRepos: repos.filter((r) => !r.isPrivate).length,
    languages,
    updated: now,
  };
}

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const formatNumber = (n) =>
  n >= 10000
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : n.toLocaleString('en-US');

function formatRange({ start, end }) {
  if (!start) return 'No active streak';
  const fmt = (iso, withYear) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(withYear && { year: 'numeric' }),
      timeZone: 'UTC',
    });
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return start === end ? fmt(start, !sameYear) : `${fmt(start, !sameYear)} – ${fmt(end, !sameYear)}`;
}

function tile({ x, y, value, unit, label, sub }) {
  const suffix = unit ? `<tspan dx="5" font-size="14" font-weight="600" fill="#8B949E">${escapeXml(unit)}</tspan>` : '';
  return `<g>
    <rect x="${x}" y="${y}" width="150" height="96" rx="14" fill="#11161F" stroke="#232A36"/>
    <text x="${x + 18}" y="${y + 44}" font-size="28" font-weight="700" fill="#F0F6FC">${escapeXml(value)}${suffix}</text>
    <text x="${x + 18}" y="${y + 66}" font-size="11" font-weight="600" letter-spacing="1.2" fill="#A78BFA">${escapeXml(label)}</text>
    <text x="${x + 18}" y="${y + 83}" font-size="11" fill="#6E7681">${escapeXml(sub)}</text>
  </g>`;
}

const dayUnit = (n) => (n === 1 ? 'day' : 'days');
const days = (n) => `${n} ${dayUnit(n)}`;

export function render(stats) {
  const tiles = [
    { value: formatNumber(stats.total), label: 'CONTRIBUTIONS', sub: `Since ${stats.since}` },
    { value: String(stats.current.length), unit: dayUnit(stats.current.length), label: 'CURRENT STREAK', sub: formatRange(stats.current) },
    { value: String(stats.longest.length), unit: dayUnit(stats.longest.length), label: 'LONGEST STREAK', sub: formatRange(stats.longest) },
    { value: formatNumber(stats.stars), label: 'STARS EARNED', sub: 'Across own repos' },
    { value: formatNumber(stats.pullRequests), label: 'PULL REQUESTS', sub: 'Opened, all time' },
    { value: formatNumber(stats.publicRepos), label: 'REPOSITORIES', sub: 'Public, non-fork' },
  ].map((t, i) => tile({ ...t, x: 40 + (i % 3) * 162, y: 58 + Math.floor(i / 3) * 108 }));

  const barX = 560;
  const barWidth = 300;
  let offset = 0;
  const segments = stats.languages
    .map((l) => {
      const width = Math.max(l.share * barWidth, 2);
      const seg = `<rect x="${(barX + offset).toFixed(2)}" y="60" width="${width.toFixed(2)}" height="10" fill="${escapeXml(l.color)}"/>`;
      offset += width;
      return seg;
    })
    .join('');

  const legend = stats.languages
    .map((l, i) => {
      const y = 104 + i * 25;
      return `<g>
      <circle cx="566" cy="${y - 4}" r="5" fill="${escapeXml(l.color)}"/>
      <text x="580" y="${y}" font-size="13" fill="#C9D1D9">${escapeXml(l.name)}</text>
      <text x="860" y="${y}" font-size="13" fill="#8B949E" text-anchor="end">${(l.share * 100).toFixed(1)}%</text>
    </g>`;
    })
    .join('');

  const updated = stats.updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300" role="img" aria-labelledby="title desc">
  <title id="title">GitHub activity</title>
  <desc id="desc">${escapeXml(
    `${stats.total} contributions since ${stats.since}, current streak ${days(stats.current.length)}, longest streak ${days(stats.longest.length)}, ${stats.stars} stars, ${stats.pullRequests} pull requests. Top languages: ${stats.languages.map((l) => l.name).join(', ')}.`,
  )}</desc>
  <style>
    text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif}
  </style>
  <defs>
    <clipPath id="bar"><rect x="${barX}" y="60" width="${barWidth}" height="10" rx="5"/></clipPath>
  </defs>
  <rect x=".5" y=".5" width="899" height="299" rx="19.5" fill="#0B0E14" stroke="#232A36"/>
  <text x="40" y="38" font-size="11" font-weight="600" letter-spacing="2" fill="#8B949E">CONTRIBUTIONS &amp; IMPACT</text>
  <text x="560" y="38" font-size="11" font-weight="600" letter-spacing="2" fill="#8B949E">TOP LANGUAGES</text>
  ${tiles.join('\n  ')}
  <rect x="${barX}" y="60" width="${barWidth}" height="10" rx="5" fill="#161B22"/>
  <g clip-path="url(#bar)">${segments}</g>
  ${legend}
  <text x="860" y="284" font-size="11" fill="#6E7681" text-anchor="end">Updated ${escapeXml(updated)}</text>
</svg>
`;
}

async function main() {
  const [output = 'dist/activity.svg'] = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  const login = process.env.GITHUB_USER ?? process.env.GITHUB_REPOSITORY_OWNER;
  if (!token || !login) throw new Error('GITHUB_TOKEN and GITHUB_USER (or GITHUB_REPOSITORY_OWNER) are required');

  const now = new Date();
  const profile = await fetchRepositories(token, login);
  const days = await fetchContributionDays(token, login, profile.createdAt, now);
  const svg = render(summarize(profile, days, now));

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, svg);
  console.log(`Wrote ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
