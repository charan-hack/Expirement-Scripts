const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const CLIENT_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20240424.01.00'
  }
};

function textFromRuns(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || '').join('');
  return '';
}

function findDeep(value, predicate) {
  const stack = [value];
  const seen = new Set();

  while (stack.length) {
    const current = stack.pop();

    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (predicate(current)) {
      return current;
    }

    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }

  return null;
}

function findAllDeep(value, predicate) {
  const matches = [];
  const stack = [value];
  const seen = new Set();

  while (stack.length) {
    const current = stack.pop();

    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (predicate(current)) {
      matches.push(current);
    }

    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }

  return matches;
}

function extractYtInitialData(html) {
  const match =
    html.match(/var ytInitialData = (\{.*?\});<\/script>/s) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});/s) ||
    html.match(/ytInitialData"\]\s*=\s*(\{.*?\});/s);

  if (!match) {
    return null;
  }

  return JSON.parse(match[1]);
}

function getInitialCommentToken(ytInitialData) {
  const commentSection = findDeep(
    ytInitialData,
    (item) => item.itemSectionRenderer?.sectionIdentifier === 'comment-item-section'
  );

  return (
    commentSection?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
      ?.continuationEndpoint?.continuationCommand?.token || null
  );
}

function getContinuationItems(data) {
  const endpoints = data.onResponseReceivedEndpoints || [];
  const items = [];

  for (const endpoint of endpoints) {
    const command = endpoint.reloadContinuationItemsCommand || endpoint.appendContinuationItemsAction;
    if (Array.isArray(command?.continuationItems)) {
      items.push(...command.continuationItems);
    }
  }

  return items;
}

function extractRendererComments(items) {
  return items
    .map((item) => item.commentThreadRenderer?.comment?.commentRenderer)
    .filter(Boolean)
    .map((renderer) => ({
      author: textFromRuns(renderer.authorText) || 'Unknown',
      text: textFromRuns(renderer.contentText),
      published: textFromRuns(renderer.publishedTimeText),
      likes: textFromRuns(renderer.voteCount)
    }))
    .filter((comment) => comment.text);
}

function collectViewModelComments(data) {
  const mutations = data.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  const authorsByKey = new Map();
  const commentsByKey = new Map();

  for (const mutation of mutations) {
    const author = mutation.payload?.authorEntityPayload;
    if (mutation.entityKey && author?.name) {
      authorsByKey.set(mutation.entityKey, author.name);
    }
  }

  for (const mutation of mutations) {
    const payload = mutation.payload?.commentEntityPayload;
    if (!payload) {
      continue;
    }

    const comment = {
      author:
        payload.author?.displayName ||
        payload.authorName ||
        authorsByKey.get(payload.authorKey) ||
        'Unknown',
      text: payload.properties?.content?.content || payload.content?.content || '',
      published: payload.properties?.publishedTime || payload.publishedTime || '',
      likes: payload.toolbar?.likeCountLiked || payload.toolbar?.likeCountNotliked || ''
    };

    if (comment.text) {
      commentsByKey.set(mutation.entityKey, comment);
    }
  }

  return commentsByKey;
}

function extractCommentEntityKeys(items) {
  return items
    .map((item) => {
      const viewModel =
        item.commentThreadRenderer?.commentViewModel ||
        item.commentViewModel ||
        item.commentViewModelRenderer ||
        item.commentThreadRenderer?.comment?.commentViewModel;

      return (
        viewModel?.commentKey ||
        viewModel?.commentEntityKey ||
        viewModel?.commentEntityPayloadKey ||
        viewModel?.comment?.commentEntityKey ||
        null
      );
    })
    .filter(Boolean);
}

function extractOrderedViewModelComments(items, commentsByKey) {
  return extractCommentEntityKeys(items)
    .map((key) => commentsByKey.get(key))
    .filter(Boolean);
}

function extractComments(data) {
  const items = getContinuationItems(data);
  const rendererComments = extractRendererComments(items);
  if (rendererComments.length) {
    return rendererComments;
  }

  const commentsByKey = collectViewModelComments(data);
  const orderedViewModelComments = extractOrderedViewModelComments(items, commentsByKey);
  if (orderedViewModelComments.length) {
    return orderedViewModelComments;
  }

  return [...commentsByKey.values()];
}

function getNextPageToken(data) {
  const items = getContinuationItems(data);
  const continuation = items.find((item) => item.continuationItemRenderer);

  return (
    continuation?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
    null
  );
}

function getNewestSortToken(data) {
  const sortOptions = findAllDeep(
    data,
    (item) => item.title && item.serviceEndpoint?.continuationCommand?.token
  );

  const newestOption = sortOptions.find((item) => {
    const title = textFromRuns(item.title).toLowerCase();
    return title.includes('newest');
  });

  return newestOption?.serviceEndpoint?.continuationCommand?.token || null;
}

async function youtubeNext(apiKey, continuation) {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: CLIENT_CONTEXT,
      continuation
    })
  });

  if (!response.ok) {
    throw new Error(`YouTube request failed with status ${response.status}`);
  }

  return response.json();
}

async function getOldestComment() {
  rl.question('Enter YouTube Video URL: ', async (url) => {
    try {
      console.log('\nFetching video page...');
      const html = await fetch(url).then((res) => res.text());

      const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      const apiKey = apiKeyMatch ? apiKeyMatch[1] : null;
      const ytInitialData = extractYtInitialData(html);

      if (!ytInitialData || !apiKey) {
        console.error('Error: Could not find YouTube data or API key. Make sure the URL is valid.');
        rl.close();
        return;
      }

      const initialToken = getInitialCommentToken(ytInitialData);

      if (!initialToken) {
        console.error('Error: Could not find comment section. The video might have comments disabled.');
        rl.close();
        return;
      }

      console.log('Loading comment controls...');
      const firstPageData = await youtubeNext(apiKey, initialToken);
      const newestToken = getNewestSortToken(ytInitialData) || getNewestSortToken(firstPageData);

      if (!newestToken) {
        console.error('Error: Could not find the "Newest" sort option.');
        rl.close();
        return;
      }

      console.log('Fetching comments newest-first until the oldest comment is reached...');
      let pageToken = newestToken;
      let oldestComment = null;
      let pageCount = 0;
      let commentCount = 0;

      while (pageToken) {
        pageCount += 1;
        const pageData = await youtubeNext(apiKey, pageToken);
        const comments = extractComments(pageData);

        if (comments.length) {
          oldestComment = comments[comments.length - 1];
          commentCount += comments.length;
        }

        process.stdout.write(`\rScanned ${commentCount} comments across ${pageCount} pages...`);
        pageToken = getNextPageToken(pageData);
      }

      process.stdout.write('\n');

      if (oldestComment) {
        console.log('\n' + '='.repeat(30));
        console.log('OLDEST COMMENT FOUND');
        console.log(`User: ${oldestComment.author}`);
        if (oldestComment.published) {
          console.log(`Published: ${oldestComment.published}`);
        }
        if (oldestComment.likes) {
          console.log(`Likes: ${oldestComment.likes}`);
        }
        console.log(`Comment: ${oldestComment.text}`);
        console.log('='.repeat(30) + '\n');
      } else {
        console.log('No comments found or could not parse the response.');
      }

      rl.close();
    } catch (error) {
      console.error('\nAn unexpected error occurred:', error.message);
      rl.close();
    }
  });
}

getOldestComment();
