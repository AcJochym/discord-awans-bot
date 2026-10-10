# discord-awans-bot

Bot Discord do zarządzania frakcją (awanse, degradacje, urlopy, nagany, szkolenia, pojazdy, zagrożenia, **tickety**).
Działa na HTTP Interactions (Express) oraz Discord Gateway, którego używa do odpowiadania na wiadomości prywatne i wiadomości z oznaczeniem bota.

## Uruchomienie

```bash
npm install
npm start
```

Zmienne środowiskowe opisuje plik `.env.example`.

## Konfiguracja w panelu

Panel wymaga `DATABASE_URL`, aby zapisywać konfiguracje serwerów w PostgreSQL. Przy starcie bot importuje pełną konfigurację z `SERVER_CONFIGS_JSON` dla każdego serwera; późniejsze zmiany zapisane w bazie są wczytywane i stosowane po restarcie.

Ustaw stabilne `CONFIG_ENCRYPTION_KEY` (minimum 16 znaków). Jeśli go nie ma, używane jest `DASHBOARD_SESSION_SECRET`. Nie zmieniaj klucza po zapisaniu sekretów, bo bot nie będzie mógł ich odszyfrować. W panelu sekrety są maskowane: pozostaw `[KEEP_EXISTING_SECRET]`, aby zachować wartość, wpisz nową, aby ją zmienić, albo wyczyść pole, aby usunąć. W bazie są szyfrowane AES-256-GCM.

Aby odpowiedzi na wiadomości działały, w Discord Developer Portal włącz **Message Content Intent** w ustawieniach bota. Bot odpowiada na DM-y i wiadomości, w których zostanie oznaczony: na `hej` wita się, na `urlop` wysyła instrukcję `/pomoc_urlop`, a na słowa `command`, `ticket`, `raport` lub `kontakt` wyjaśnia, jak otworzyć ticket. Inne wiadomości dostają krótką podpowiedź.

## Bezpieczeństwo panelu

- Każda odpowiedź ma nagłówki bezpieczeństwa (CSP ze świeżym `nonce` dla skryptów, `X-Frame-Options: DENY`, HSTS na https).
- Trasy zmieniające dane (POST/PUT/DELETE) sprawdzają źródło żądania (ochrona CSRF).
- Limity zapytań na adres IP: logowanie 40/min, API 1500/min (zapisy 150/min). Strumień zdarzeń i `/api/health` są pomijane.
- Wszystkie zapytania do Discorda mają limit czasu (10 s, wysyłanie plików 60 s) i ponawianie przy błędzie 429.
- Błędy techniczne nie trafiają do przeglądarki — użytkownik widzi tylko ogólny komunikat, szczegóły są w logach Railway.
- `/api/health` zwraca tylko `ok` i czas działania.

## Baza danych i działanie ciągłe

Przy braku połączenia z PostgreSQL bot nie przestaje działać: ponawia połączenie co 10 s, a logi, archiwum ticketów
i nieobecności czekają w pamięci i są zapisywane po powrocie bazy. Po powrocie bazy ponownie wczytywane są też
zapisane konfiguracje serwerów. Przy zamykaniu (SIGTERM z Railway) bot kończy zapisy i zamyka połączenia.
Ustawienia użytkownika panelu (przeczytane tickety, dźwięk powiadomień) są zapisywane w bazie, więc działają na każdym urządzeniu.

## Testy

```bash
npm test
```

Testy (wbudowany `node:test`, bez dodatkowych zależności) obejmują: uprawnienia kanałów, role administracji,
zabezpieczenia HTTP (CSRF, limity, CSP) oraz magazyn logów (filtry, statystyki, eksport CSV, archiwum).

## System ticketów (styl Ticket Tool)

Kod: `tickets.js`, podpięty w `index.js` jedną linijką (`handleTicketInteraction`).

1. Dodaj sekcję `TICKETS` do konfiguracji serwera w `SERVER_CONFIGS_JSON` (patrz `.env.example`).
2. Ustaw `DISCORD_APPLICATION_ID` i zarejestruj komendy: `npm run register-tickets`
   (skrypt tworzy tylko komendy `ticket_*`, istniejących nie rusza).
3. Na kanale z panelem użyj `/ticket_panel`.

Komendy: `/ticket_panel`, `/ticket_zamknij`, `/ticket_dodaj`, `/ticket_usun`, `/ticket_nazwa`.
Przyciski w tickecie: Zamknij, Przejmij; po zamknięciu: Otwórz ponownie, Transkrypt, Usuń.

Uprawnienia bota: Zarządzanie kanałami, Zarządzanie rolami, Wyświetlanie kanałów, Wysyłanie wiadomości,
Osadzanie linków, Załączanie plików, Czytanie historii wiadomości. Wymagany Node.js 18+.

Stan ticketu jest trzymany w temacie kanału (`ticket|ownerId|typ|open/closed`), więc nie potrzeba bazy danych.

Dziękujemy za korzystanie z bota i życzymy miłego administrowania serwerem! 🚀
Jeśli chcesz, możemy w przyszłości rozbudować go o dodatkowe moduły, automatyzacje i lepsze integracje.
