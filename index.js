/**
 * KoKrŠNeK — Cloud Functions pro push notifikace
 * =================================================
 * 10 triggerů, každý reaguje na zápis do Firestore (nebo na denní plán) a
 * pošle push notifikaci ostatním členům party (nikdy tomu, kdo akci udělal):
 *
 *   1. onLikeCreated       — nový lajk u události
 *   2. onAttendCreated     — nové "Dojdu" u události
 *   3. onDeclineCreated    — nové "Nedojdu" u události
 *   4. onCommentCreated    — nový komentář (jen top-level, notifikace všem kromě autora)
 *   5. onCommentReaction   — odpověď na komentář NEBO emoji reakce na komentář;
 *                            v obou případech notifikace jen autorovi toho komentáře
 *   6. onPhotoAlbumAdded   — appka detekovala nové album fotek u události
 *   7. onExpenseListAdded  — appka detekovala novou přílohu "seznam nákladů" u události
 *   8. onQuizScoreWritten  — někdo tě předhonil v kvízu
 *   9. sendEventReminders  — denně v 8:00 (Europe/Prague): připomínka lidem s "Dojdu"
 *                            pro akce, které jsou dnes nebo přesně za týden
 *  10. onPokeCreated       — šťouchnutí nebo krátká soukromá zpráva jedné osobě
 *                            (viz index.html -> sendPoke()/sendPrivateMessage())
 *
 * Tokeny zařízení se čtou z kolekce `pushTokens` (doc ID = token, pole {user, token, at}),
 * kterou appka plní přes tlačítko zvonečku (viz index.html -> toggleNotifications()).
 */

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// --- Pomocné funkce -------------------------------------------------------

const DAYS_CZ = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** Datum jako "YYYY-MM-DD" v pražském čase — pro spolehlivé porovnávání kalendářních dní. */
function czDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Naformátuje ISO datum akce na "po 7. 9. 2026" — den v týdnu + den. měsíc. rok. */
function formatEventDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${DAYS_CZ[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}

/** Vrátí tokeny všech lidí KROMĚ zadaného jména (aby si nikdo nepingnul sám sebe). */
async function getTokensExcept(excludeUser) {
  const snap = await db.collection('pushTokens').get();
  const tokens = [];
  snap.forEach((doc) => {
    const data = doc.data();
    if (data.token && data.user !== excludeUser) tokens.push(data.token);
  });
  return tokens;
}

/** Vrátí tokeny konkrétního jednoho člověka (může mít appku na víc zařízeních). */
async function getTokensFor(targetUser) {
  const snap = await db.collection('pushTokens').where('user', '==', targetUser).get();
  const tokens = [];
  snap.forEach((doc) => {
    if (doc.data().token) tokens.push(doc.data().token);
  });
  return tokens;
}

/** Pošle notifikaci na seznam tokenů a rovnou smaže ty, co už nejsou platné (appka odinstalovaná apod.). */
async function sendToTokens(tokens, notification) {
  if (!tokens.length) return;
  try {
    // POZOR: posíláme jen `data`, ne `notification`. Když payload obsahuje pole
    // `notification`, prohlížeč na pozadí zobrazí systémovou notifikaci SÁM
    // automaticky, a navíc ji zobrazí i náš vlastní kód v sw.js — výsledkem by
    // byly dvě notifikace na jednu událost. S čistě `data` payloadem to zobrazí
    // vždy jen náš vlastní kód, přesně jednou.
    // eventId cestuje spolu s notifikací, aby klik na ni (sw.js -> notificationclick)
    // uměl appku otevřít rovnou na kartě té konkrétní akce.
    const resp = await messaging.sendEachForMulticast({
      tokens,
      data: {
        title: notification.title || '',
        body: notification.body || '',
        eventId: notification.eventId || '',
      },
    });
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalid.push(tokens[i]);
        }
      }
    });
    if (invalid.length) {
      const batch = db.batch();
      invalid.forEach((t) => batch.delete(db.collection('pushTokens').doc(t)));
      await batch.commit();
    }
  } catch (e) {
    console.error('Chyba při odesílání push notifikace:', e);
  }
}

// --- 1) Nový lajk -----------------------------------------------------------

exports.onLikeCreated = onDocumentCreated(
  'events/{eventId}/likes/{userId}',
  async (event) => {
    const data = event.data.data();
    if (!data || !data.user) return;
    const dateStr = formatEventDate(data.eventStart);
    const eventTitle = data.eventTitle || 'akci';
    const tokens = await getTokensExcept(data.user);
    await sendToTokens(tokens, {
      title: '❤️ Nový lajk',
      body: `${data.user}\n„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 2) Nové "Dojdu" ---------------------------------------------------------

exports.onAttendCreated = onDocumentCreated(
  'events/{eventId}/attendees/{userId}',
  async (event) => {
    const data = event.data.data();
    if (!data || !data.user) return;
    const dateStr = formatEventDate(data.eventStart);
    const eventTitle = data.eventTitle || 'akci';
    const tokens = await getTokensExcept(data.user);
    await sendToTokens(tokens, {
      title: '👍 Nová účast',
      body: `${data.user}\n„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 3) Nové "Nedojdu" --------------------------------------------------------

exports.onDeclineCreated = onDocumentCreated(
  'events/{eventId}/declines/{userId}',
  async (event) => {
    const data = event.data.data();
    if (!data || !data.user) return;
    const dateStr = formatEventDate(data.eventStart);
    const eventTitle = data.eventTitle || 'akci';
    const tokens = await getTokensExcept(data.user);
    await sendToTokens(tokens, {
      title: '👎 Nedojde',
      body: `${data.user}\n„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 4) Nový komentář (top-level) / odpověď / emoji reakce ------------------

exports.onCommentCreated = onDocumentCreated(
  'events/{eventId}/comments/{commentId}',
  async (event) => {
    const data = event.data.data();
    if (!data || !data.user) return;
    const eventTitle = data.eventTitle || 'akci';
    const dateStr = formatEventDate(data.eventStart);
    const eventLine = `„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`;
    const snippet = (data.text || '').slice(0, 100);

    // Odpověď na komentář -> notifikace JEN autorovi rodičovského komentáře,
    // nikomu jinému (žádný obecný broadcast).
    if (data.parentId) {
      try {
        const parentSnap = await event.data.ref.parent.doc(data.parentId).get();
        const parentAuthor = parentSnap.exists ? parentSnap.data().user : null;
        if (parentAuthor && parentAuthor !== data.user) {
          const replyTokens = await getTokensFor(parentAuthor);
          await sendToTokens(replyTokens, {
            title: '💬 Odpověď na tvůj komentář',
            body: `${data.user}\n${eventLine}\n${snippet}`,
            eventId: event.params.eventId,
          });
        }
      } catch (e) {
        console.error('Nepodařilo se dohledat rodičovský komentář:', e);
      }
      return;
    }

    // Nový (top-level) komentář -> obecná notifikace všem ostatním kromě autora
    const snap = await db.collection('pushTokens').get();
    const generalTokens = [];
    snap.forEach((doc) => {
      const d = doc.data();
      if (d.token && d.user !== data.user) generalTokens.push(d.token);
    });

    await sendToTokens(generalTokens, {
      title: '💬 Nový komentář',
      body: `${data.user}\n${eventLine}\n${snippet}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 5) Emoji reakce na komentář ---------------------------------------------
// Trigger: update dokumentu komentáře (appka mění pole `reactions`, viz
// index.html -> toggleCommentReaction()). Notifikujeme JEN autora okomentovaného
// komentáře, a jen o nově přidané reakci (ne o jejím zrušení), nikdy sám sobě.

exports.onCommentReaction = onDocumentUpdated(
  'events/{eventId}/comments/{commentId}',
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    if (!after.user) return;

    const beforeReactions = before.reactions || {};
    const afterReactions = after.reactions || {};

    // Najdi nově přidané reakce — u appky je aktivní vždy jen jedna reakce na
    // osobu, takže se tu typicky objeví max. jedna nová dvojice {user, emoji}.
    const added = [];
    Object.keys(afterReactions).forEach((emoji) => {
      const beforeUsers = beforeReactions[emoji] || [];
      const afterUsers = afterReactions[emoji] || [];
      afterUsers.forEach((u) => {
        if (!beforeUsers.includes(u)) added.push({ user: u, emoji });
      });
    });
    if (!added.length) return;

    const eventTitle = after.eventTitle || 'akci';
    const dateStr = formatEventDate(after.eventStart);
    const eventLine = `„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`;
    const snippet = (after.text || '').slice(0, 100);
    const tokens = await getTokensFor(after.user);
    if (!tokens.length) return;

    for (const { user, emoji } of added) {
      if (user === after.user) continue; // reakce na vlastní komentář se neposílá
      await sendToTokens(tokens, {
        title: `${emoji} Reakce na tvůj komentář`,
        body: `${user}\n${eventLine}\n${snippet}`,
        eventId: event.params.eventId,
      });
    }
  }
);

// --- 6) Nové album fotek -----------------------------------------------------
// Trigger: photoAlbums/{eventId} — appka sem zapíše záznam, jakmile u nedávno
// upravené kalendářové události poprvé objeví album (viz index.html ->
// syncAlbumAndExpenseNotifications()). Díky .set() na pevné ID dokumentu se
// tenhle trigger (onCreate) spustí jen jednou, i kdyby to detekovalo víc zařízení.

exports.onPhotoAlbumAdded = onDocumentCreated(
  'photoAlbums/{eventId}',
  async (event) => {
    const data = event.data.data();
    if (!data) return;
    const eventTitle = data.eventTitle || 'akci';
    const dateStr = formatEventDate(data.eventStart);
    const snap = await db.collection('pushTokens').get();
    const tokens = [];
    snap.forEach((doc) => { if (doc.data().token) tokens.push(doc.data().token); });
    await sendToTokens(tokens, {
      title: '📷 Nové album fotek',
      body: `„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 7) Nový seznam nákladů ---------------------------------------------------
// Trigger: expenseLists/{eventId} — stejný princip jako u alb, jen appka sem
// zapisuje při detekci přílohy, jejíž název obsahuje "náklady".

exports.onExpenseListAdded = onDocumentCreated(
  'expenseLists/{eventId}',
  async (event) => {
    const data = event.data.data();
    if (!data) return;
    const eventTitle = data.eventTitle || 'akci';
    const dateStr = formatEventDate(data.eventStart);
    const snap = await db.collection('pushTokens').get();
    const tokens = [];
    snap.forEach((doc) => { if (doc.data().token) tokens.push(doc.data().token); });
    await sendToTokens(tokens, {
      title: '💶 Nový seznam nákladů',
      body: `„${eventTitle}“${dateStr ? `\n${dateStr}` : ''}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 8) Překonání výsledku v kvízu -------------------------------------------
// Trigger: events/_quiz_leaderboard/scores/{name} — appka sem zapisuje jen
// tehdy, když je nový streak vyšší než dosavadní nejlepší výsledek daného člověka.

exports.onQuizScoreWritten = onDocumentWritten(
  'events/_quiz_leaderboard/scores/{name}',
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return;
    const afterData = after.data();
    const newName = afterData.name || event.params.name;
    const newScore = afterData.score || 0;

    const scoresSnap = await db
      .collection('events')
      .doc('_quiz_leaderboard')
      .collection('scores')
      .get();

    let prevLeader = null;
    let prevLeaderScore = -1;
    scoresSnap.forEach((doc) => {
      if (doc.id === event.params.name) return; // vynech sám sebe
      const s = doc.data().score || 0;
      if (s > prevLeaderScore) {
        prevLeaderScore = s;
        prevLeader = doc.data().name || doc.id;
      }
    });

    // Notifikuj jen pokud nový výsledek skutečně překonal dosavadního lídra
    if (prevLeader && newScore > prevLeaderScore) {
      const tokens = await getTokensFor(prevLeader);
      await sendToTokens(tokens, {
        title: '🏆 Byl jsi překonán v kvízu!',
        body: `${newName} tě předhonil(a) se skóre ${newScore} (tvoje bylo ${prevLeaderScore}).`,
      });
    }
  }
);

// --- 9) Denní připomínky (8:00, Europe/Prague) -------------------------------
// Pro každou akci, na kterou má aspoň jeden člověk zapsané "Dojdu", zkontroluje,
// jestli akce je DNES nebo přesně ZA TÝDEN, a pokud ano, pošle připomínku všem,
// kdo mají u té akce "Dojdu". Datum a název akce se berou z pole eventStart/
// eventTitle, které appka ukládá do každého dokumentu v `attendees` (viz
// index.html -> toggleAttend()) — nevyžaduje to tedy žádný přístup ke kalendáři
// ze strany Cloud Function.

exports.sendEventReminders = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Europe/Prague' },
  async () => {
    const now = new Date();
    const todayStr = czDateStr(now);
    const weekAheadStr = czDateStr(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));

    const snap = await db.collectionGroup('attendees').get();

    // Seskup záznamy podle akce (ID rodičovského dokumentu v `events`)
    const events = {};
    snap.forEach((doc) => {
      const data = doc.data();
      if (!data || !data.user || !data.eventStart) return;
      const eventId = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;
      if (!eventId) return;
      if (!events[eventId]) {
        events[eventId] = { eventTitle: data.eventTitle || 'akci', eventStart: data.eventStart, users: new Set() };
      }
      events[eventId].users.add(data.user);
    });

    for (const [eventId, info] of Object.entries(events)) {
      const evDate = new Date(info.eventStart);
      if (isNaN(evDate.getTime())) continue;
      const evStr = czDateStr(evDate);

      let title = null;
      if (evStr === todayStr) title = '🔔 Dnes máš akci';
      else if (evStr === weekAheadStr) title = '📅 Za týden tě čeká akce';
      if (!title) continue;

      const dateStr = formatEventDate(info.eventStart);
      const tokens = [];
      for (const user of info.users) {
        tokens.push(...(await getTokensFor(user)));
      }
      if (!tokens.length) continue;

      await sendToTokens(tokens, {
        title,
        body: `„${info.eventTitle}“${dateStr ? `\n${dateStr}` : ''}`,
        eventId,
      });
    }
  }
);

// --- 10) Šťouchnutí / soukromá zpráva ----------------------------------------
// Trigger: pokes/{pokeId} — appka sem zapíše záznam při kliknutí na 💬/👊 u jména
// v "historii aktivity osoby" (viz index.html -> sendPoke()/sendPrivateMessage()).
// Notifikace jde VÝHRADNĚ osobě v poli `to`, nikomu jinému.

exports.onPokeCreated = onDocumentCreated(
  'pokes/{pokeId}',
  async (event) => {
    const data = event.data.data();
    if (!data || !data.from || !data.to) return;
    const tokens = await getTokensFor(data.to);
    if (!tokens.length) return;

    if (data.type === 'message' && data.text) {
      await sendToTokens(tokens, {
        title: '💬 Zpráva',
        body: `${data.from}: ${data.text}`,
      });
    } else {
      await sendToTokens(tokens, {
        title: '👊 Šťouchnutí',
        body: `${data.from} do tebe hipl`,
      });
    }
  }
);
