# discord-awans-bot

Bot Discord do zarządzania frakcją (awanse, degradacje, urlopy, nagany, szkolenia, pojazdy, zagrożenia, **tickety**).
Działa na HTTP Interactions (Express) — bez połączenia z gatewayem.

## Uruchomienie

```bash
npm install
npm start
```

Zmienne środowiskowe opisuje plik `.env.example`.

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
