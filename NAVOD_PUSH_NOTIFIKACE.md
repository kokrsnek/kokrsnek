# Návod: zapnutí push notifikací pro KoKrŠNeK

Tenhle návod tě provede od nuly až po fungující push notifikace. Musíš ho projít
na počítači (ne na mobilu) — potřebuješ terminál a Firebase CLI.

Předpoklad: máš nainstalovaný [Node.js](https://nodejs.org) (stačí LTS verze).

---

## 1. Přepnutí na Blaze plán

1. Otevři [Firebase Console](https://console.firebase.google.com) → projekt `kokrsnek-4bdc7`
2. Vlevo dole klikni na **Upgrade** (nebo ikonu ozubeného kola → Usage and billing)
3. Zvol **Blaze — Pay as you go**
4. Přidej platební kartu
5. Doporučuju hned nastavit rozpočtové upozornění: **Billing → Budgets & alerts** → nový rozpočet, např. na $1

## 2. Vygenerování VAPID klíče (pro web push)

1. Ve Firebase Console: **Project settings** (ozubené kolo vlevo nahoře) → záložka **Cloud Messaging**
2. Sjeď dolů na **Web configuration** → **Web Push certificates**
3. Klikni **Generate key pair**
4. Zkopíruj vygenerovaný klíč (dlouhý řetězec znaků)
5. Otevři `index.html` a najdi řádek:
   ```js
   const VAPID_KEY = 'VLOŽ_SEM_SVUJ_VAPID_KLIC';
   ```
   Nahraď `VLOŽ_SEM_SVUJ_VAPID_KLIC` svým klíčem a soubor ulož.

## 3. Instalace Firebase CLI (pokud ho ještě nemáš)

```bash
npm install -g firebase-tools
firebase login
```
Otevře se prohlížeč, přihlas se stejným Google účtem jako do Firebase Console.

## 4. Příprava projektu k nasazení

V lokální složce s repem `kokrsnek` (tam, kde máš `index.html`, `manifest.json`, `sw.js`)
už je připravená složka `functions/` s hotovým kódem (`index.js`, `package.json`).

Pokud v repu ještě nemáš `firebase.json`, spusť:
```bash
firebase init
```
- Zvol **Functions** (mezerníkem označ, Enter potvrdí)
- Vyber existující projekt → `kokrsnek-4bdc7`
- Jazyk: **JavaScript**
- ESLint: klidně **No**
- **DŮLEŽITÉ:** až se zeptá, jestli přepsat `functions/index.js` a `functions/package.json` —
  odpověz **N (ne)**, ať nepřepíšeš už hotové soubory, co jsem připravil.

Pak nainstaluj závislosti:
```bash
cd functions
npm install
cd ..
```

## 5. Nasazení Cloud Functions

```bash
firebase deploy --only functions
```

Vypíše se průběh nasazení 4 funkcí:
- `onLikeCreated`
- `onAttendCreated`
- `onCommentCreated`
- `onQuizScoreWritten`

Trvá to typicky 1–3 minuty. Na konci by mělo být „✔ Deploy complete!".

## 6. Nahrání zbytku na GitHub

Nahraj do repa (rozbal přímo do rootu, přepiš stávající):
- `index.html`
- `sw.js`
- `manifest.json` (beze změny)
- `icon-192v2.png`, `icon-512v2.png` (beze změny)

Vercel automaticky nasadí novou verzi.

## 7. Zapnutí notifikací v appce

1. Otevři appku (na Vercel doméně, ne GitHub Pages)
2. Klikni na ikonku zvonečku vpravo nahoře (vedle přepínače tmavý/světlý režim)
3. Prohlížeč se zeptá na povolení notifikací → **Povolit**
4. Ikonka zezelená = notifikace jsou zapnuté

Zopakuj to na zařízeních všech, kdo notifikace chce dostávat. Appka si token
uloží do Firestore kolekce `pushTokens` pod jejich přezdívkou.

## 8. Otestování

- Na jednom zařízení lajkni nějakou událost
- Na druhém zařízení (s jiným jménem a zapnutými notifikacemi) by měla do pár
  sekund přijít notifikace, i když je appka zavřená

---

## Poznámky

- **Cena:** při jednotkách interakcí denně a cca 30 lidech zůstaneš hluboko
  v bezplatné kvótě Blaze plánu (viz naše dřívější probrání) — reálně $0/měsíc.
- **iOS:** push notifikace u PWA fungují od iOS 16.4+ a **jen** pokud je appka
  přidaná na plochu (přesně jak to používáte) — v obyčejném Safari tabu to
  nefunguje.
- **Firestore Security Rules:** pokud appka nedovolí zapisovat do nové kolekce
  `pushTokens` (chyba typu „Missing or insufficient permissions"), zkontroluj
  pravidla ve Firebase Console → Firestore Database → Rules a přidej pro ni
  stejná pravidla jako pro ostatní kolekce.
- Kdyby se něco nepovedlo nasadit, zkopíruj mi prosím chybovou hlášku
  z terminálu a pomůžu to doladit.
