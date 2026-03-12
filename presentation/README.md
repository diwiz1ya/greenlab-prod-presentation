# Customer Presentation

Файл презентации:

- `presentation/greenlab-prod-presentation.html`

Автоматический сбор актуальных скриншотов из запущенного приложения:

```bash
npm run capture:presentation
```

По умолчанию скрипт ждёт сервис на:

- `http://127.0.0.1:3011`

Если у вас другой адрес/порт:

```bash
BASE_URL=http://127.0.0.1:3010 npm run capture:presentation
```

Скриншоты сохраняются в:

- `presentation/assets/*.png`

## GitHub Pages (публичная ссылка)

В репо добавлен workflow:

- `.github/workflows/deploy-presentation-pages.yml`

Что сделать один раз в GitHub:

1. `Settings -> Pages`
2. `Build and deployment -> Source: GitHub Actions`
3. Запушить изменения в `main` (или `master`)

После этого GitHub опубликует:

- `https://<username>.github.io/<repo>/`

Стартовая страница:

- `presentation/index.html` (редирект на `greenlab-prod-presentation.html`)
