# Freax CQA

**Команда Freax.** Оценка клиентских диалогов по настраиваемому чек-листу: баллы, цитаты, история, апелляции и пакетная обработка.

Стек: HTML/CSS/JavaScript, Node.js 24, GPT-6.1 Terra. Ключ модели хранится на сервере.

## Запуск

Создайте локальный `.env` по [.env.example](.env.example), затем:

```sh
node --env-file-if-exists=.env scripts/start-prod.mjs
```

[Локальное приложение](http://127.0.0.1:3000/) · [Облачное приложение](https://3000-4vjgjfmni.gobrev.dev) — вход владельца через NVIDIA/Brev.

## Сдача

- [DEV results.json](results/dev/results.json): 65 диалогов, 54 полных.
- [PROD results.json](results/prod/results.json): 10 FBroker, 9 полных после отдельного пересмотра; один неопределённый 04. [Детали и расходы](docs/prod-terra-2026-11-08.txt).
- [Презентация, 2 слайда](presentations/Freax-CQA-Doomsday-demo.pptx): стек и стоимость (~$0.041/чат).
- [Порядок сдачи](docs/submission-morning-guide-2026-11-08.txt) · [Форма организаторов](https://forms.gle/Nz34xz4yK4XurwAt7).

## Проверка и интеграция

```sh
node --test "tests/*.test.js"
```

85 тестов проходят. Внутреннее N/A экспортируется как `null`; неизвестные оценки сохраняются как ошибки. В редакторе доступна последняя версия правил и сохранение новой. Старые оценки не меняются.

[Dynamics 365](integrations/dynamics365/README.md) — адаптер готов, реальный tenant не подключён. [Развёртывание](deploy/README.md) · [Исследование гипотез](docs/hypotheses-generalization-2026-11-08.txt).
