/**
 * Browserless X search via X's internal GraphQL API.
 *
 * This is the no-Chrome path: instead of driving a logged-in browser, we call
 * the same GraphQL `SearchTimeline` endpoint x.com itself uses, authenticated
 * with an account's cookies. Returns JSON directly — fast, tiny, and hostable
 * anywhere (Render included) because there is no browser to keep alive.
 *
 * You supply two cookie values from a logged-in (burner) X account:
 *   X_AUTH_TOKEN  — the `auth_token` cookie
 *   X_CT0         — the `ct0` cookie (also sent as the x-csrf-token header)
 * Get them from a browser: DevTools → Application → Cookies → https://x.com.
 * They last a few weeks; refresh when search starts returning 401/403.
 *
 * Mechanics verified against twscrape (github.com/vladkens/twscrape):
 *   - endpoint + SearchTimeline query id
 *   - public web bearer token
 *   - the required `features` object
 *   - cursor pagination (the "cursor-bottom" entry)
 * X rotates the query id every ~2-4 weeks; if search suddenly 404s, update
 * SEARCH_QUERY_ID below (the value twscrape keeps current).
 */
import { logger } from './logger';

// Public web-app bearer (same value X's frontend ships; not a secret).
const BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const GQL_URL = 'https://x.com/i/api/graphql';
// Fallback if runtime discovery fails. X rotates this every ~2-4 weeks; the
// resolveSearchQueryId() below pulls the live one from X's JS so this rarely
// matters. (Verified current 2026-05.)
const SEARCH_QUERY_ID_FALLBACK = '-TFXKoMnMTKdEXcCn-eahw/SearchTimeline';

// Feature flags X requires on a search request (verbatim from twscrape).
const GQL_FEATURES = {
  articles_preview_enabled: false,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_media_download_video_enabled: false,
  responsive_web_profile_redirect_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  rweb_video_timestamps_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_awards_web_tipping_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  tweet_with_visibility_results_prefer_gql_media_interstitial_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  verified_phone_label_enabled: false,
  view_counts_everywhere_api_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  premium_content_api_read_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: false,
  responsive_web_grok_share_attachment_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_grok_analysis_button_from_backend: false,
  responsive_web_jetfuel_frame: false,
  rweb_video_screen_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
};

const FIELD_TOGGLES = { withArticleRichContentState: false };

export interface ApiPost {
  id: string;
  url: string;
  handle: string;
  name: string;
  ts: string; // ISO
  text: string;
  type: 'original' | 'reply' | 'quote' | 'repost';
  images: string[]; // large-rendition photo URLs
  replies: number;
  retweets: number;
  likes: number;
  bookmarks: number;
  views: number;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedQueryId: string | null = null;

/**
 * Discover the CURRENT SearchTimeline query id from X's public JS bundle, so we
 * survive X's monthly query-id rotation without a code change. Falls back to the
 * pinned value on any failure. Cached for the process lifetime.
 */
export async function resolveSearchQueryId(): Promise<string> {
  if (cachedQueryId) return cachedQueryId;
  try {
    const home = await fetch('https://x.com/', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    const html = await home.text();
    const mainUrl =
      html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.\w+\.js/)?.[0] ??
      (html.match(/client-web\/main\.\w+\.js/)?.[0] && `https://abs.twimg.com/responsive-web/${html.match(/client-web\/main\.\w+\.js/)?.[0]}`);
    if (mainUrl) {
      const js = await (await fetch(mainUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })).text();
      const id = js.match(/queryId:"([^"]+)",operationName:"SearchTimeline"/)?.[1];
      if (id) {
        cachedQueryId = `${id}/SearchTimeline`;
        logger.info(`xapi: resolved live SearchTimeline query id (${id})`);
        return cachedQueryId;
      }
    }
    logger.warn('xapi: could not resolve live query id — using pinned fallback');
  } catch (e) {
    logger.warn(`xapi: query-id discovery failed (${e instanceof Error ? e.message : e}) — using fallback`);
  }
  cachedQueryId = SEARCH_QUERY_ID_FALLBACK;
  return cachedQueryId;
}

function creds(): { auth: string; ct0: string } {
  const auth = process.env.X_AUTH_TOKEN ?? '';
  const ct0 = process.env.X_CT0 ?? '';
  if (!auth || !ct0) {
    throw new Error('X_AUTH_TOKEN and X_CT0 must be set (the auth_token + ct0 cookies of a logged-in X account)');
  }
  return { auth, ct0 };
}

function headers(): Record<string, string> {
  const { auth, ct0 } = creds();
  return {
    authorization: BEARER,
    'x-csrf-token': ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    cookie: `auth_token=${auth}; ct0=${ct0}`,
  };
}

function buildUrl(queryId: string, rawQuery: string, cursor?: string): string {
  const variables: Record<string, unknown> = {
    rawQuery,
    count: 20,
    querySource: 'typed_query',
    product: 'Latest',
  };
  if (cursor) variables.cursor = cursor;
  const qs = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GQL_FEATURES),
    fieldToggles: JSON.stringify(FIELD_TOGGLES),
  });
  return `${GQL_URL}/${queryId}?${qs.toString()}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RawResult {
  posts: ApiPost[];
  cursor: string | null;
}

/** Walk one SearchTimeline response into posts + the bottom cursor. Exported for tests. */
export function parse(json: any): RawResult {
  const out: ApiPost[] = [];
  let cursor: string | null = null;
  const instructions =
    json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

  for (const ins of instructions) {
    const entries = ins?.entries ?? (ins?.entry ? [ins.entry] : []);
    for (const e of entries) {
      const entryId: string = e?.entryId ?? '';
      if (entryId.startsWith('cursor-bottom')) {
        cursor = e?.content?.value ?? cursor;
        continue;
      }
      if (!entryId.startsWith('tweet-')) continue;

      let result = e?.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
      const legacy = result?.legacy;
      if (!legacy) continue;

      const id: string = result?.rest_id ?? legacy?.id_str ?? '';
      if (!id) continue;

      const userResult = result?.core?.user_results?.result ?? {};
      const userLegacy = userResult?.legacy ?? {};
      const userCore = userResult?.core ?? {};
      const handle: string = userLegacy.screen_name ?? userCore.screen_name ?? '';
      const name: string = userLegacy.name ?? userCore.name ?? '';

      const mediaArr = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
      const images: string[] = mediaArr
        .filter((m: any) => m?.type === 'photo' && m?.media_url_https)
        .map((m: any) => `${m.media_url_https}?name=large`);

      const createdAt: string = legacy?.created_at ?? '';
      const ts = createdAt && !Number.isNaN(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : '';

      const type: ApiPost['type'] = legacy?.retweeted_status_result
        ? 'repost'
        : legacy?.is_quote_status
          ? 'quote'
          : legacy?.in_reply_to_status_id_str
            ? 'reply'
            : 'original';

      out.push({
        id,
        url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
        handle,
        name,
        ts,
        text: legacy?.full_text ?? '',
        type,
        images,
        replies: legacy?.reply_count | 0,
        retweets: (legacy?.retweet_count | 0) + (legacy?.quote_count | 0),
        likes: legacy?.favorite_count | 0,
        bookmarks: legacy?.bookmark_count | 0,
        views: Number(result?.views?.count ?? legacy?.ext_views?.count ?? 0) || 0,
      });
    }
  }
  return { posts: out, cursor };
}

/**
 * Search the "Latest" tab for a query and page to exhaustion (or maxPosts).
 * De-dupes by id. Honours X's rate-limit headers and backs off on 429/limit.
 */
export async function searchLatest(rawQuery: string, maxPosts = 5000): Promise<ApiPost[]> {
  const queryId = await resolveSearchQueryId();
  const seen = new Map<string, ApiPost>();
  let cursor: string | undefined;
  let page = 0;
  let emptyStreak = 0;

  while (seen.size < maxPosts && page < 400) {
    page++;
    const url = buildUrl(queryId, rawQuery, cursor);
    let rep: Response;
    try {
      rep = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      logger.warn(`xapi: fetch error p${page} — ${e instanceof Error ? e.message : e}; retrying in 5s`);
      await sleep(5000);
      continue;
    }

    if (rep.status === 429) {
      const reset = Number(rep.headers.get('x-rate-limit-reset') ?? 0) * 1000;
      const wait = reset > Date.now() ? Math.min(reset - Date.now() + 1000, 16 * 60_000) : 60_000;
      logger.warn(`xapi: rate-limited — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (rep.status === 401 || rep.status === 403) {
      throw new Error(`xapi: auth failed (${rep.status}) — cookies likely expired; refresh X_AUTH_TOKEN / X_CT0`);
    }
    if (rep.status === 404) {
      throw new Error('xapi: 404 — SearchTimeline query id may have rotated; update SEARCH_QUERY_ID in src/xapi.ts');
    }
    if (!rep.ok) {
      logger.warn(`xapi: HTTP ${rep.status} p${page}; backing off 10s`);
      await sleep(10_000);
      continue;
    }

    const json = await rep.json().catch(() => null);
    if (!json) {
      await sleep(3000);
      continue;
    }
    const { posts, cursor: next } = parse(json);
    const before = seen.size;
    for (const p of posts) if (!seen.has(p.id)) seen.set(p.id, p);
    const added = seen.size - before;

    const remaining = rep.headers.get('x-rate-limit-remaining');
    logger.info(`xapi "${rawQuery}" p${page}: +${added} (total ${seen.size})${remaining ? ` [rl:${remaining}]` : ''}`);

    // stop conditions: no new tweets twice in a row, or no/again-same cursor
    if (added === 0) emptyStreak++;
    else emptyStreak = 0;
    if (emptyStreak >= 2 || !next || next === cursor) break;
    cursor = next;

    // gentle pacing well under the ~500/15min budget
    await sleep(1200 + Math.random() * 800);
  }

  return [...seen.values()];
}
