"""
X fetch collector for krexa-bill-bot.

Uses twscrape (which generates X's required x-client-transaction-id and tracks
the rotating GraphQL query ids) to search a query and print normalised posts as
a JSON array on stdout. The Node side (src/collect.ts) OCRs the images and stores
the result — this script only fetches.

Usage:  python3 collector.py "<query>" <limit>
Env:    X_AUTH_TOKEN, X_CT0  (cookies of a logged-in X account)
"""
import asyncio
import json
import os
import sys

from twscrape import API, gather


def post_type(t) -> str:
    if getattr(t, "retweetedTweet", None):
        return "repost"
    if getattr(t, "quotedTweet", None):
        return "quote"
    if getattr(t, "inReplyToTweetId", None):
        return "reply"
    return "original"


async def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "#krexabillchallenge"
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 1000

    auth = os.environ.get("X_AUTH_TOKEN", "")
    ct0 = os.environ.get("X_CT0", "")
    if not auth or not ct0:
        print(json.dumps({"error": "X_AUTH_TOKEN and X_CT0 required"}), file=sys.stderr)
        sys.exit(2)
    cookies = f"auth_token={auth}; ct0={ct0}"

    # Make .env the source of truth: drop any cached account and re-add with the
    # current cookies, so refreshing X_AUTH_TOKEN/X_CT0 actually takes effect.
    api = API()
    try:
        await api.pool.delete_accounts(["krexa_collector"])
    except Exception:
        pass
    await api.pool.add_account("krexa_collector", "x", "x@example.com", "x", cookies=cookies)
    try:
        await api.pool.login_all()
    except Exception:
        pass

    tweets = await gather(api.search(query, limit=limit))

    # Distinguish "no results" from "dead session". twscrape silently flips the
    # account inactive on a 401/ban and returns []. Detect that and exit 3 so the
    # Node side can alert instead of looping forever thinking there are 0 posts.
    try:
        info = await api.pool.accounts_info()
        acc = next((a for a in info if a.get("username") == "krexa_collector"), None)
        if acc is not None and not acc.get("active", True):
            print(json.dumps({"error": "auth_failed", "detail": acc.get("error_msg") or "session expired or banned"}), file=sys.stderr)
            sys.exit(3)
    except SystemExit:
        raise
    except Exception:
        pass

    out = []
    for t in tweets:
        photos = []
        if getattr(t, "media", None) and t.media.photos:
            photos = [p.url + "?name=large" for p in t.media.photos]
        out.append({
            "id": str(t.id),
            "url": t.url,
            "handle": t.user.username,
            "name": t.user.displayname or "",
            "ts": t.date.isoformat() if t.date else "",
            "text": t.rawContent or "",
            "type": post_type(t),
            "images": photos,
            "replies": int(getattr(t, "replyCount", 0) or 0),
            "retweets": int(getattr(t, "retweetCount", 0) or 0) + int(getattr(t, "quoteCount", 0) or 0),
            "likes": int(getattr(t, "likeCount", 0) or 0),
            "bookmarks": int(getattr(t, "bookmarkedCount", 0) or 0),
            "views": int(getattr(t, "viewCount", 0) or 0),
        })

    print(json.dumps(out))


asyncio.run(main())
