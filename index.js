/**
 * KoKrŠNeK — Cloud Functions pro push notifikace
 * =================================================
 * 15 triggerů, každý reaguje na zápis do Firestore (nebo na denní plán) a
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
 *   8. onQuizScoreWritten  — někdo tě předhonil v kvízu (jen na 1. místě)
 *   9. sendEventReminders  — denně v 8:00 (Europe/Prague): připomínka lidem s "Dojdu"
 *                            pro akce, které jsou dnes nebo přesně za týden
 *  10. onPokeCreated       — šťouchnutí nebo krátká soukromá zpráva jedné osobě
 *                            (viz index.html -> sendPoke()/sendPrivateMessage())
 *  11. onNewEventAdded     — appka detekovala úplně novou (nedávno vytvořenou) akci
 *                            v Google Kalendáři — notifikace celé partě
 *  12. onEventSnapshotUpdated — appka detekovala změnu data nebo místa u budoucí
 *                            akce — notifikace jen lidem, co mají Dojdu/Nedojdu
 *  13. sendBirthdayNamedayPush — denně v 8:00: narozeniny/svátek člena party, pošle
 *                            se CELÉ partě (ne jen tomu, kdo zrovna otevře appku)
 *  14. sendLowRsvpReminder — denně v 8:00: akce za 3 dny má skoro žádné odpovědi
 *  15. onChatMessageCreated — nová zpráva v minichatu (viz index.html -> openChatThread())
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

// --- 11) Nová akce v kalendáři ------------------------------------------------
// Trigger: newEventAlerts/{eventId} — appka sem zapíše záznam, jakmile objeví
// budoucí událost, jejíž pole `created` z Google Kalendáře je nové (poslední
// týden). Díky té podmínce se při prvním nasazení nezaplaví notifikacemi
// celá několikaletá historie kalendáře — projdou jen opravdu nově založené akce.

exports.onNewEventAdded = onDocumentCreated(
  'newEventAlerts/{eventId}',
  async (event) => {
    const data = event.data.data();
    if (!data) return;
    const dateStr = formatEventDate(data.eventStart);
    const snap = await db.collection('pushTokens').get();
    const tokens = [];
    snap.forEach((doc) => { if (doc.data().token) tokens.push(doc.data().token); });
    await sendToTokens(tokens, {
      title: '🆕 Nová akce',
      body: `„${data.eventTitle || 'akci'}“${dateStr ? `\n${dateStr}` : ''}${data.eventPlace ? `\n${data.eventPlace}` : ''}`,
      eventId: event.params.eventId,
    });
  }
);

// --- 12) Změna data nebo místa u budoucí akce --------------------------------
// Trigger: eventSnapshots/{eventId} — appka sem při KAŽDÉM načtení zapíše
// aktuální datum/místo každé budoucí akce (viz index.html -> syncEventNotifications()).
// Tenhle trigger reaguje jen na UPDATE (ne na první zápis), takže při nasazení
// nic neposílá — spustí se, až se něco opravdu změní. Notifikace jde jen lidem,
// co už mají u té akce zapsané Dojdu nebo Nedojdu.

exports.onEventSnapshotUpdated = onDocumentUpdated(
  'eventSnapshots/{eventId}',
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const startChanged = before.eventStart !== after.eventStart;
    const placeChanged = (before.eventPlace || '') !== (after.eventPlace || '');
    if (!startChanged && !placeChanged) return;

    const eventId = event.params.eventId;
    const [attendSnap, declineSnap] = await Promise.all([
      db.collection('events').doc(eventId).collection('attendees').get(),
      db.collection('events').doc(eventId).collection('declines').get(),
    ]);
    const users = new Set();
    attendSnap.forEach((d) => { if (d.data().user) users.add(d.data().user); });
    declineSnap.forEach((d) => { if (d.data().user) users.add(d.data().user); });
    if (!users.size) return;

    const tokens = [];
    for (const user of users) { tokens.push(...(await getTokensFor(user))); }
    if (!tokens.length) return;

    const changes = [];
    if (startChanged) changes.push(`nové datum: ${formatEventDate(after.eventStart)}`);
    if (placeChanged) changes.push(`nové místo: ${after.eventPlace || '—'}`);

    await sendToTokens(tokens, {
      title: '⚠️ Změna u akce',
      body: `„${after.eventTitle || 'akce'}“\n${changes.join('\n')}`,
      eventId,
    });
  }
);

// --- 13) Narozeniny a svátky členů party (8:00, Europe/Prague) --------------
// POZOR: seznam PEOPLE a kalendář NAMEDAYS jsou kopie stejných dat z index.html
// (checkBirthdaysAndNamedays) — při úpravě jednoho uprav i druhé, jinak se appka
// a push notifikace rozjedou. Rozdíl oproti appce: tohle jde push notifikací
// CELÉ partě, ne jen tomu, kdo zrovna toho dne appku otevře.

const PEOPLE = [
  {name:'Leoš', day:17, month:6, nick:'Gudasovi'},
  {name:'Iva', day:null, month:null, nick:'Ivě'},
  {name:'Lukáš', day:29, month:6, nick:'Šurajovi'},
  {name:'Michal', day:30, month:12, nick:'Miškovi'},
  {name:'Michal', day:25, month:2, nick:'Majklovi'},
  {name:'Markéta', day:null, month:null, nick:'Markétě'},
  {name:'Doubravka', day:29, month:1, nick:'Doubravce'},
  {name:'Alexej', day:30, month:6, nick:'Alexovi'},
  {name:'Jana', day:30, month:12, nick:'Maleně'},
  {name:'Petr', day:null, month:null, nick:'Pecákovi'},
  {name:'Petr', day:null, month:null, nick:'Peckovi'},
  {name:'Stanislava', day:null, month:null, nick:'Slávce'},
  {name:'Jaromír', day:18, month:8, nick:'Pifovi'},
  {name:'Zuzana', day:null, month:null, nick:'Zuzce'},
  {name:'Tomáš', day:13, month:4, nick:'Gučimu'},
  {name:'Veronika', day:null, month:null, nick:'Verči'},
  {name:'Miroslav', day:17, month:2, nick:'Mírovi'},
  {name:'Josef', day:29, month:11, nick:'Bazimu'},
  {name:'Lenka', day:null, month:null, nick:'Lence'},
  {name:'Pavel', day:15, month:3, nick:'Čentovi'},
  {name:'Lenka', day:null, month:null, nick:'Bugině'},
  {name:'Pavel', day:null, month:null, nick:'Pavlovi'},
  {name:'Petra', day:null, month:null, nick:'Petře'},
  {name:'Vladimír', day:null, month:null, nick:'Hugovi'},
  {name:'David', day:null, month:null, nick:'Dejvovi'},
  {name:'Šárka', day:null, month:null, nick:'Šárce'},
  {name:'Richard', day:null, month:null, nick:'Richardovi'},
  {name:'Josef', day:null, month:null, nick:'Joskovi'},
  {name:'Dagmar', day:null, month:null, nick:'Dáši'},
  {name:'Pavel', day:null, month:null, nick:'Bormenovi'},
  {name:'Vladimír', day:null, month:null, nick:'Rosomákovi'},
  {name:'Aleš', day:null, month:null, nick:'Ájisovi'},
  {name:'Lukáš', day:null, month:null, nick:'manželovi Jany Gazdové'},
  {name:'Jana', day:null, month:null, nick:'manželce Lukáše Konečného'},
  {name:'Vojtěch', day:null, month:null, nick:'Těchovi'},
];

const NAMEDAYS = {
  "1.1":"Nový rok","2.1":"Karina","3.1":"Radmila","4.1":"Diana","5.1":"Dalimil",
  "6.1":"Tři králové","7.1":"Vilma","8.1":"Čestmír","9.1":"Vladan","10.1":"Břetislav",
  "11.1":"Bohdana","12.1":"Pravoslav","13.1":"Edita","14.1":"Radovan","15.1":"Alice",
  "16.1":"Ctirad","17.1":"Drahoslav","18.1":"Vladislav","19.1":"Doubravka","20.1":"Ilona",
  "21.1":"Kamila","22.1":"Slavomír","23.1":"Zdeněk","24.1":"Milena","25.1":"Miloš",
  "26.1":"Zora","27.1":"Ingrid","28.1":"Otýlie","29.1":"Zdislava","30.1":"Robin",
  "31.1":"Marika","1.2":"Hynek","2.2":"Nela","3.2":"Blažej","4.2":"Jarmila",
  "5.2":"Dobromila","6.2":"Vanda","7.2":"Veronika","8.2":"Milada","9.2":"Apolena",
  "10.2":"Mojmír","11.2":"Božena","12.2":"Slavěna","13.2":"Věnceslava","14.2":"Valentýn",
  "15.2":"Jiřina","16.2":"Ljuba","17.2":"Miloslav","18.2":"Gizela","19.2":"Patrik",
  "20.2":"Oldřich","21.2":"Lenka","22.2":"Isabela","23.2":"Svatopluk","24.2":"Matěj",
  "25.2":"Liliana","26.2":"Dorota","27.2":"Alexandr","28.2":"Lumír","29.2":"Horymír",
  "1.3":"Albín","2.3":"Anežka","3.3":"Kamil","4.3":"Stela","5.3":"Kazimír",
  "6.3":"Miroslav","7.3":"Tomáš","8.3":"Gabriela","9.3":"Františka","10.3":"Viktorie",
  "11.3":"Anděla","12.3":"Řehoř","13.3":"Růžena","14.3":"Rút","15.3":"Ida",
  "16.3":"Elena","17.3":"Vlastimil","18.3":"Eduard","19.3":"Josef","20.3":"Světlana",
  "21.3":"Radek","22.3":"Leona","23.3":"Ivona","24.3":"Gabriel","25.3":"Marián",
  "26.3":"Emanuela","27.3":"Dita","28.3":"Soňa","29.3":"Taťána","30.3":"Arnošt",
  "31.3":"Kvido","1.4":"Hugo","2.4":"Erika","3.4":"Richard","4.4":"Ivana",
  "5.4":"Miroslava","6.4":"Vendula","7.4":"Heřman","8.4":"Ema","9.4":"Dušan",
  "10.4":"Dáša","11.4":"Izabela","12.4":"Julius","13.4":"Aleš","14.4":"Vincenc",
  "15.4":"Anastázie","16.4":"Irena","17.4":"Rudolf","18.4":"Valérie","19.4":"Rostislav",
  "20.4":"Marcela","21.4":"Alexandra","22.4":"Evžénie","23.4":"Vojtěch","24.4":"Jiří",
  "25.4":"Marek","26.4":"Oto","27.4":"Jaroslav","28.4":"Vlastislav","29.4":"Robert",
  "30.4":"Blahoslav","1.5":"Svátek práce","2.5":"Zikmund","3.5":"Alexej","4.5":"Florian",
  "5.5":"Klaudie","6.5":"Radoslav","7.5":"Stanislav","8.5":"Den vítězství","9.5":"Ctibor",
  "10.5":"Blahomír","11.5":"Svatava","12.5":"Pankrác","13.5":"Servác","14.5":"Bonifác",
  "15.5":"Žofie","16.5":"Přemysl","17.5":"Aneta","18.5":"Nataša","19.5":"Ivo",
  "20.5":"Zbyněk","21.5":"Monika","22.5":"Emil","23.5":"Vladimír","24.5":"Jana",
  "25.5":"Viola","26.5":"Filip","27.5":"Valerie","28.5":"Vilém","29.5":"Maxmilián",
  "30.5":"Ferdinand","31.5":"Kamila","1.6":"Laura","2.6":"Jarmil","3.6":"Tamara",
  "4.6":"Dalibor","5.6":"Dobroslav","6.6":"Norbert","7.6":"Slavomíra","8.6":"Medard",
  "9.6":"Stanislava","10.6":"Gita","11.6":"Bruno","12.6":"Antonie","13.6":"Antonín",
  "14.6":"Roland","15.6":"Vít","16.6":"Zuzana","17.6":"Adolf","18.6":"Milan",
  "19.6":"Leoš","20.6":"Květa","21.6":"Alois","22.6":"Pavla","23.6":"Zdeňka",
  "24.6":"Jan","25.6":"Ivan","26.6":"Adriana","27.6":"Ladislav","28.6":"Lubomír",
  "29.6":"Petr","30.6":"Pavel","1.7":"Jaroslava","2.7":"Patricie","3.7":"Radomír",
  "4.7":"Prokop","5.7":"Cyril a Metoděj","6.7":"Jan Hus","7.7":"Bohuslava",
  "8.7":"Nora","9.7":"Drahomíra","10.7":"Libuše","11.7":"Olga","12.7":"Bořek",
  "13.7":"Markéta","14.7":"Karolína","15.7":"Jindřich","16.7":"Luboš","17.7":"Martina",
  "18.7":"Drahomír","19.7":"Čeněk","20.7":"Ilja","21.7":"Vítězslav","22.7":"Magdaléna",
  "23.7":"Libor","24.7":"Kristýna","25.7":"Jakub","26.7":"Anna","27.7":"Věroslav",
  "28.7":"Viktor","29.7":"Marta","30.7":"Bořivoj","31.7":"Ignác","1.8":"Oskar",
  "2.8":"Gustav","3.8":"Miluše","4.8":"Dominik","5.8":"Kristián","6.8":"Oldřiška",
  "7.8":"Lada","8.8":"Soběslav","9.8":"Roman","10.8":"Vavřinec","11.8":"Zuzana",
  "12.8":"Klára","13.8":"Alena","14.8":"Alan","15.8":"Hana","16.8":"Jáchym",
  "17.8":"Petra","18.8":"Helena","19.8":"Ludvík","20.8":"Bernard","21.8":"Johana",
  "22.8":"Bohuslav","23.8":"Sandra","24.8":"Bartoloměj","25.8":"Radim","26.8":"Luděk",
  "27.8":"Otakar","28.8":"Augustýn","29.8":"Evelína","30.8":"Vladěna","31.8":"Pavlína",
  "1.9":"Linda","2.9":"Adéla","3.9":"Bronislav","4.9":"Jindřiška","5.9":"Boris",
  "6.9":"Boleslav","7.9":"Regína","8.9":"Mariana","9.9":"Daniela","10.9":"Irma",
  "11.9":"Denisa","12.9":"Marie","13.9":"Lubor","14.9":"Radka","15.9":"Jolana",
  "16.9":"Ludmila","17.9":"Naděžda","18.9":"Kryštof","19.9":"Werner","20.9":"Oleg",
  "21.9":"Matouš","22.9":"Darina","23.9":"Berta","24.9":"Jaromír","25.9":"Zlata",
  "26.9":"Andrea","27.9":"Jonáš","28.9":"Václav","29.9":"Michal","30.9":"Jeroným",
  "1.10":"Igor","2.10":"Olivie","3.10":"Bohumil","4.10":"František","5.10":"Eliška",
  "6.10":"Hanuš","7.10":"Justýna","8.10":"Věra","9.10":"Štefan","10.10":"Marina",
  "11.10":"Andrej","12.10":"Marcel","13.10":"Renata","14.10":"Agáta","15.10":"Tereza",
  "16.10":"Havel","17.10":"Hedvika","18.10":"Lukáš","19.10":"Michaela","20.10":"Vendelin",
  "21.10":"Brigita","22.10":"Sabina","23.10":"Teodor","24.10":"Nina","25.10":"Beáta",
  "26.10":"Erik","27.10":"Šarlota","28.10":"Den vzniku ČSR","29.10":"Silvie","30.10":"Tadeáš",
  "31.10":"Štěpánka","1.11":"Felix","2.11":"Dušičky","3.11":"Hubert","4.11":"Karel",
  "5.11":"Miriam","6.11":"Libert","7.11":"Saskie","8.11":"Bohumír","9.11":"Bohdan",
  "10.11":"Evžen","11.11":"Martin","12.11":"Renáta","13.11":"Tibor","14.11":"Sáva",
  "15.11":"Leopold","16.11":"Otmar","17.11":"Den boje za svobodu","18.11":"Romana",
  "19.11":"Alžběta","20.11":"Nikola","21.11":"Albert","22.11":"Cecílie","23.11":"Klement",
  "24.11":"Emílie","25.11":"Kateřina","26.11":"Artur","27.11":"Xenie","28.11":"René",
  "29.11":"Zina","30.11":"Ondřej","1.12":"Iva","2.12":"Blanka","3.12":"Svatoslav",
  "4.12":"Barbora","5.12":"Mikuláš","6.12":"Mikuláš","7.12":"Ambrož","8.12":"Květoslava",
  "9.12":"Vratislav","10.12":"Julie","11.12":"Dana","12.12":"Simona","13.12":"Lucie",
  "14.12":"Lýdie","15.12":"Radana","16.12":"Albína","17.12":"Daniel","18.12":"Miloslav",
  "19.12":"Ester","20.12":"Dagmar","21.12":"Natálie","22.12":"Šimon","23.12":"Vlasta",
  "24.12":"Štědrý den","25.12":"Boží hod vánoční","26.12":"Štěpán","27.12":"Žaneta",
  "28.12":"Božena","29.12":"Judita","30.12":"David","31.12":"Silvestr"
};

function getNameday(d) {
  const key = `${d.getDate()}.${d.getMonth() + 1}`;
  return NAMEDAYS[key] || '';
}

exports.sendBirthdayNamedayPush = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Europe/Prague' },
  async () => {
    const today = new Date();
    const todayDay = today.getDate();
    const todayMonth = today.getMonth() + 1;

    const birthdayMatches = PEOPLE.filter((p) => p.day === todayDay && p.month === todayMonth);
    const nameday = getNameday(today);
    const namedayMatches = nameday ? PEOPLE.filter((p) => p.name === nameday) : [];
    if (!birthdayMatches.length && !namedayMatches.length) return;

    const snap = await db.collection('pushTokens').get();
    const tokens = [];
    snap.forEach((doc) => { if (doc.data().token) tokens.push(doc.data().token); });
    if (!tokens.length) return;

    for (const p of birthdayMatches) {
      await sendToTokens(tokens, { title: '🎂 Narozeniny!', body: `Nezapomeň dnes popřát ${p.nick}` });
    }
    if (namedayMatches.length) {
      const nicks = namedayMatches.map((p) => p.nick);
      const body = nicks.length === 1
        ? `Nezapomeň dnes popřát ${nicks[0]}`
        : `Nezapomeň dnes popřát: ${nicks.join(', ')}`;
      await sendToTokens(tokens, { title: `🎉 Svátek má ${nameday}!`, body });
    }
  }
);

// --- 14) Připomenutí, když akce za 3 dny ještě nemá skoro žádné odpovědi ----
// Zdroj dat: eventSnapshots (zapisuje appka pro KAŽDOU budoucí akci, i tu bez
// jediné odezvy) — díky tomu víme o akci i v případě, že na ni ještě nikdo
// nekliknul Dojdu/Nedojdu.

exports.sendLowRsvpReminder = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Europe/Prague' },
  async () => {
    const targetStr = czDateStr(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    const snap = await db.collection('eventSnapshots').get();
    if (snap.empty) return;

    const tokensSnap = await db.collection('pushTokens').get();
    const allTokens = [];
    tokensSnap.forEach((doc) => { if (doc.data().token) allTokens.push(doc.data().token); });
    if (!allTokens.length) return;

    for (const doc of snap.docs) {
      const data = doc.data();
      if (!data.eventStart) continue;
      const evDate = new Date(data.eventStart);
      if (isNaN(evDate.getTime()) || czDateStr(evDate) !== targetStr) continue;

      const [attendSnap, declineSnap] = await Promise.all([
        db.collection('events').doc(doc.id).collection('attendees').get(),
        db.collection('events').doc(doc.id).collection('declines').get(),
      ]);
      const totalResponses = attendSnap.size + declineSnap.size;
      if (totalResponses > 1) continue; // "skoro nikdo" = 0 nebo 1 odpověď

      await sendToTokens(allTokens, {
        title: '🔔 Akce za 3 dny ještě čeká na odpovědi',
        body: `„${data.eventTitle || 'akce'}“ (${formatEventDate(data.eventStart)}) — zatím odpovědělo jen ${totalResponses} ${totalResponses === 1 ? 'člověk' : 'lidí'}. Dej vědět, jestli dorazíš!`,
        eventId: doc.id,
      });
    }
  }
);

// --- 15) Minichat --------------------------------------------------------------
// Trigger: chats/{threadId}/messages/{msgId} — threadId jsou oba nicky seřazené
// abecedně a spojené "__" (viz index.html -> chatThreadId()). Notifikace jde
// tomu z dvojice, kdo zprávu NENAPSAL.

exports.onChatMessageCreated = onDocumentCreated(
  'chats/{threadId}/messages/{msgId}',
  async (event) => {
    const data = event.data.data();
    if (!data || !data.from || !data.text) return;
    const participants = event.params.threadId.split('__');
    const to = participants.find((p) => p !== data.from);
    if (!to) return;
    const tokens = await getTokensFor(to);
    if (!tokens.length) return;
    await sendToTokens(tokens, {
      title: `💬 ${data.from}`,
      body: data.text,
    });
  }
);
