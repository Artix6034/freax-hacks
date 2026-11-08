# Dynamics 365 / model-driven Power Apps

Freax остаётся Node.js-приложением. Эти HTML/JS/CSS web resources встраивают его в форму. Реальный tenant пока не подключён: отсутствуют URL и доступ к CRM. Контракт обмена проверяется локальными тестами.

1. Разверните Freax с HTTPS. В серверной конфигурации задайте `CQA_PUBLIC_ORIGIN=https://freax-host` и `CQA_EMBED_ORIGINS=https://YOUR-ORG.crm4.dynamics.com`. Только точные origins, без путей. Несколько CRM origins разделяются запятой. На свежем запуске конфигурация применяется при старте.
2. В solution загрузите `freax-host.html`, `freax-host.js`, `freax-host.css` с одинаковым префиксом/папкой, чтобы относительные ссылки сохранялись. Добавьте HTML web resource в форму, высота от 700 px. Отключите опцию ограничения cross-frame scripting для этого доверенного web resource.
3. Загрузите `freax-form.js` как JavaScript web resource. В `FreaxCqa.settings` укажите имя контрола, URL приложения и логическое имя многострочного поля с JSON транскрипта. Дополнительное `resultField` необязательно, получает JSON сводки, форму автоматически не сохраняет.
4. На событие OnLoad формы зарегистрируйте `FreaxCqa.onLoad`, включите передачу execution context. Скрипт использует официальный `getContentWindow()`, а не устаревший `Xrm.Page`.
5. Поле транскрипта должно содержать нормализованный объект: `conversation_id`, `channel` (`agent chat` / `voice call`), `language` (RU/KZ/EN), `transcript`: массив `{message_id,timestamp,speaker,text}`. Роли: client/operator/bot/system. Даты ISO 8601. Формат организатора также проходит через серверный импорт.
6. Откройте запись. Транскрипт передаётся только после handshake с разрешённым родителем. AI запускается исключительно кнопкой пользователя. В форму возвращается сводка: evaluation_id, conversation_id, status, checklist_version, total, gross_error. Транскрипт и ключ провайдера обратно не отправляются.

Если используется приватный Brev HTTP endpoint, сначала войдите в Brev. Политика third-party cookies или запрет framing со стороны шлюза могут блокировать iframe. Для боевой CRM нужен доступный сотрудникам HTTPS host с согласованной серверной авторизацией. Внешний доступ к платному AI API нельзя открывать без защиты.

Microsoft API: https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/controls/getcontentwindow
