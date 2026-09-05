# Návod: nasazení KoKrŠNeK na Vercel

Appka je čisté HTML/JS bez jakéhokoliv sestavovacího kroku (build), takže nasazení
na Vercel je otázka pár kliknutí — žádný Node.js, žádný `npm run build`.

---

## 1. Založení projektu na Vercelu

1. Jdi na [vercel.com](https://vercel.com) a přihlas se **přes GitHub účet** (tlačítko
   "Continue with GitHub") — použij ten samý účet, pod kterým máš repo `kokrsnek/kokrsnek`.
2. Klikni **Add New...** → **Project**.
3. Najdi v seznamu repo `kokrsnek/kokrsnek` a klikni **Import**.
4. V nastavení projektu:
   - **Framework Preset:** nech na **Other** (appka nic nesestavuje)
   - **Root Directory:** nech výchozí (`.`, tedy root repa)
   - **Build Command:** nech prázdné / vypnuté
   - **Output Directory:** nech prázdné (Vercel automaticky použije root)
5. Klikni **Deploy**.

Za pár vteřin dostaneš adresu typu `kokrsnek.vercel.app` (nebo podobnou — Vercel
přidává náhodný sufix, pokud je jméno obsazené).

## 2. Soubory v tomto zipu

Nic se nemusí upravovat — appka používá jen relativní cesty (`./index.html`,
`icon-192v2.png` apod.), takže poběží stejně na Vercelu jako na GitHub Pages.
Stačí mít v rootu repa:

- `index.html`
- `manifest.json`
- `sw.js`
- `icon-192v2.png`, `icon-512v2.png`
- **`vercel.json`** ← nový soubor, klíčový pro tohle nasazení (viz níže)

## 3. Co dělá `vercel.json`

```json
{
  "headers": [
    { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
    { "source": "/", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
    { "source": "/manifest.json", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
    { "source": "/sw.js", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] }
  ]
}
```

Tohle řekne Vercelu (přesněji jeho CDN), ať `index.html`, `manifest.json` a `sw.js`
**nikdy neukládá do cache** — v kombinaci s tím, že `sw.js` sám navíc stahuje HTML
s `{cache:'no-store'}`, máš ochranu proti zastaralé appce na dvou úrovních zároveň
(server i klient). Ikony (`icon-192v2.png`, `icon-512v2.png`) záměrně necachujeme
speciálně — ty se nemění, takže normální cachování jim neuškodí.

## 4. Ověření, že hlavičky opravdu fungují

Po nasazení otevři v prohlížeči na počítači:
```
https://tvoje-adresa.vercel.app/index.html
```
a v Developer Tools (F12) → záložka **Network** → klikni na `index.html` →
zkontroluj v **Response Headers**, že je tam `cache-control: no-cache, no-store, must-revalidate`.
Pokud tam je, `vercel.json` funguje správně.

## 5. Přechod na telefonech ze staré GitHub Pages appky

1. Appku smaž z plochy (podrž ikonu → Odebrat appku)
2. **Nastavení → Aplikace → Safari → Rozšířené → Data webů** → najdi a smaž jak
   `kokrsnek.github.io`, tak novou `kokrsnek.vercel.app` adresu (kdyby tam náhodou
   z dřívějšího testování už byla)
3. Restartuj telefon (pomáhá to skutečně zahodit starý service worker)
4. Otevři **novou Vercel adresu** v Safari, zkontroluj že appka vypadá správně
5. **Sdílet → Přidat na plochu**

Zopakuj pro všechny testery.

## 6. Volitelné: vlastní doména

V nastavení projektu na Vercelu → **Settings → Domains** můžeš přidat vlastní
doménu (např. `kokrsnek.cz`), pokud ji vlastníš — Vercel tě provede nastavením
DNS záznamů.

## 7. Vypnutí GitHub Pages (doporučeno)

Aby appka existovala jen na jedné adrese a nikdo omylem neotevřel tu starou:

1. GitHub repo → **Settings** → **Pages**
2. **Build and deployment → Source** → přepni na **None**
3. Ulož

Po vypnutí appce na `kokrsnek.github.io` přestane fungovat (zobrazí 404), zmizí
i ty opakující se "pages build and deployment" běhy v Actions.

## 8. Další nasazování

Od teď stačí normálně **pushnout do `main`** — Vercel automaticky nasadí novou
verzi během pár desítek vteřin, úplně stejně pohodlně jako GitHub Pages, jen
s navíc těmi cache hlavičkami z `vercel.json`.

## 9. Push notifikace — nic se nemění

Firebase konfigurace, VAPID klíč a Cloud Functions fungují nezávisle na tom,
odkud appku servíruješ — žádná další úprava kvůli přechodu na Vercel není potřeba.
