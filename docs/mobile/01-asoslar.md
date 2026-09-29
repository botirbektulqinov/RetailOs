# 01 — Asoslar

> Bu faylni **birinchi va to'liq** o'qing. Undagi qoidalar barcha 105 ta
> endpointga tegishli. Keyingi fayllar ularni takrorlamaydi.

---

## 1. Manzil va versiya

```
https://api.finmates.app/api/v1/<resurs>
```

Versiya **yo'lda**, sarlavhada emas. `/api/v2` chiqsa `/api/v1` ishlashda
davom etadi — ilovani majburan yangilash kerak bo'lmaydi.

**Barcha so'rovlar HTTPS.** HTTP so'rov avtomatik HTTPS ga yo'naltiriladi.

---

## 2. Autentifikatsiya

Ikkitadan tashqari barcha endpointlar token talab qiladi:

```http
Authorization: Bearer <accessToken>
```

Tokensiz ishlaydigan ikkitasi: `POST /auth/login` va `POST /auth/refresh`.

Token 15 daqiqa yashaydi. Muddati tugasa `401` + `code: "TOKEN_EXPIRED"`
qaytadi — bu **xato emas, kutilgan holat**. Ilova refresh qiladi va so'rovni
takrorlaydi. Batafsil: [02-auth.md](02-auth.md).

---

## 3. Pul

**Pul — butun son (integer), so'mning eng kichik birligida.**

UZS uchun eksponent 0, ya'ni tiyin yo'q. Demak:

| JSON | Ma'nosi |
|---|---|
| `450000` | 450 000 so'm |
| `1500` | 1 500 so'm |
| `0` | 0 so'm |
| `-5000` | −5 000 so'm (kamomad, qaytarish) |

### Qoidalar

**Hech qachon `double` yoki `float` ishlatmang.** Dart'da `int` oling. Katta
summalarda (masalan 15 000 000 so'm) `double` aniqlikni yo'qotadi va kassa
hisoboti chiqmay qoladi.

**Kasr yo'q.** `450000.50` degan narsa bo'lmaydi. Server bunday qiymatni qabul
qilmaydi.

**Ba'zi maydonlar satr sifatida keladi.** Hisobot va kassa endpointlari juda
katta summalarni satr qilib qaytaradi (`"stockValue": "36131250"`), chunki ular
JSON son chegarasidan (2^53) oshishi mumkin. Bunday maydonni `int.parse()` yoki
`BigInt.parse()` bilan o'qing. Qaysi maydon satr ekani har bir faylda
ko'rsatilgan.

### Foydalanuvchiga ko'rsatish

`450000` → `450 000 so'm`. Ming ajratgichi — probel (yoki ` `). Vergul yoki
nuqta ishlatmang: `450.000` O'zbekistonda chalkashlik keltiradi.

---

## 4. Miqdor

**Miqdor — satr (string), aniq 3 ta kasr xonasi bilan.**

| JSON | Ma'nosi |
|---|---|
| `"1.000"` | 1 dona |
| `"1.500"` | 1.5 kg |
| `"0.250"` | 250 gramm |
| `"-3.000"` | −3 (kamaytirish) |

### Nega satr

Chunki `0.1 + 0.2 != 0.3`. Suzuvchi nuqta 1.5 kg go'shtni 1.4999999 qiladi va
ombor qoldig'i asta-sekin haqiqatdan uzoqlashadi. Server tomonda bu
`NUMERIC(14,3)` — matematik jihatdan aniq tip.

### Qoidalar

**Yuborishda har doim 3 ta kasr xonasi bilan formatlang.** `"1.5"` emas,
`"1.500"`. Dart'da: `value.toStringAsFixed(3)`.

**O'qishda `double` ga aylantirmang** — agar faqat ko'rsatish kerak bo'lsa,
satrni o'sha holicha ishlating. Arifmetika kerak bo'lsa `Decimal` paketidan
foydalaning (`decimal` pub paketi), `double` dan emas.

**Nol miqdor qabul qilinmaydi.** Sotuv qatori, tuzatish — hammasida miqdor
noldan katta (yoki tuzatishda manfiy) bo'lishi shart.

---

## 5. Xatolar — RFC 9457

Har bir xato bir xil shaklda keladi:

```json
{
  "type": "https://docs.retailos.uz/errors/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "code": "INSUFFICIENT_STOCK",
  "detail": "Omborda yetarli qoldiq yo'q: Nestle sut 1L — 3 dona bor, 5 so'ralgan.",
  "traceId": "ce50358f-...",
  "timestamp": "2026-09-29T10:41:05.836Z",
  "errors": [
    { "code": "INSUFFICIENT_STOCK", "message": "...", "meta": { "variantId": "...", "available": "3.000" } }
  ]
}
```

| Maydon | Nima uchun |
|---|---|
| `code` | **Shartni shunga yozing.** Barqaror, hech qachon o'zgarmaydi |
| `detail` | Foydalanuvchiga ko'rsatish uchun o'zbekcha matn. **Shartga ishlatmang** |
| `status` | HTTP kodi |
| `traceId` | Log'da qidirish uchun. Xato ekranida kichik shriftda ko'rsating — qo'llab-quvvatlash so'raydi |
| `errors[]` | Bir nechta muammo bo'lganda (masalan validatsiya). `meta` ichida foydali tafsilot bo'ladi |

### HTTP kodlarining ma'nosi

| Kod | Ma'nosi | Ilova nima qiladi |
|---|---|---|
| `400` | So'rov noto'g'ri tuzilgan | Dasturchi xatosi. Formani tekshiring |
| `401` | Token yo'q, eskirgan yoki bekor qilingan | Refresh qiling, bo'lmasa login ekraniga |
| `403` | Ruxsat yo'q | "Sizda bu amal uchun ruxsat yo'q" deb ko'rsating. Tugmani oldindan yashirgan ma'qul |
| `404` | Topilmadi | |
| `409` | Biznes qoidasi buzildi | **Eng muhim toifa.** `detail` ni ko'rsating — u odam o'qishi uchun yozilgan |
| `422` | Ma'lumot mantiqan noto'g'ri | `409` bilan bir xil muomala |
| `429` | Juda ko'p so'rov | Kuting va qayta urinib ko'ring |
| `5xx` | Server xatosi | "Qayta urinib ko'ring" + `traceId` |

### Eng ko'p uchraydigan `code` lar

Ilova ularga **alohida muomala qilishi kerak**:

| `code` | Qachon | Ilova nima qiladi |
|---|---|---|
| `TOKEN_EXPIRED` | Access token eskirdi | Refresh, so'rovni takrorlash |
| `TOKEN_INVALID` | Token buzuq yoki bekor qilingan | Login ekraniga |
| `INVALID_CREDENTIALS` | Telefon yoki parol xato | "Telefon yoki parol noto'g'ri" |
| `INSUFFICIENT_STOCK` | Qoldiq yetmaydi | Qaysi mahsulot — `meta` da. Qatorni qizil qiling |
| `CREDIT_LIMIT_EXCEEDED` | Mijozning qarz chegarasi to'ldi | Qarzga berishni bloklang |
| `CREDIT_WITHOUT_CUSTOMER` | Mijozsiz qarzga sotish | Mijoz tanlashni majburlang |
| `IDEMPOTENCY_KEY_REQUIRED` | Sarlavha yuborilmagan | Dasturchi xatosi — 7-bo'limga qarang |
| `REQUEST_IN_PROGRESS` | O'sha kalit bilan so'rov hali ketyapti | Kuting, qayta yubormang |
| `PAYMENT_MISMATCH` | To'lovlar jami chekka teng emas | Hisobni qayta tekshiring |
| `RETURN_WINDOW_EXPIRED` | Qaytarish muddati o'tgan | |
| `SHIFT_ALREADY_OPEN` | Kassada smena allaqachon ochiq | |
| `STORE_ACCESS_DENIED` | Bu do'konga biriktirilmagansiz | |
| `RATE_LIMIT_EXCEEDED` | Limit | Kuting |

To'liq ro'yxat — 85 ta kod — Swagger'da har bir endpointning javoblari ostida.

---

## 6. Ro'yxat va sahifalash

**Barcha ro'yxat endpointlari bir xil konvertda qaytadi:**

```json
{
  "data": [ { "id": "...", "...": "..." } ],
  "page": {
    "limit": 50,
    "offset": 0,
    "total": 237,
    "hasMore": true
  }
}
```

`data` — har doim massiv, hech qachon `null` emas. Bo'sh bo'lsa `[]`.

### So'rov parametrlari

Har bir ro'yxat endpointi quyidagilarni qabul qiladi:

| Parametr | Ma'nosi |
|---|---|
| `q` | Matnli qidiruv. Qaysi maydonlar bo'yicha — resursga qarab |
| `limit` | Sahifa hajmi. Standart `50`, **maksimum `100`** |
| `offset` | Nechtasini o'tkazib yuborish. Standart `0` |
| `sort` | Masalan `createdAt:desc`. Ruxsat etilgan maydonlar resursga qarab |
| `dateFrom` / `dateTo` | ISO-8601 sana oralig'i, ikki tomoni ham kiradi |

> `limit=10000` yuborsangiz **xato qaytmaydi** — server uni jimgina `100` ga
> tushiradi. Ya'ni "hammasini bir so'rovda olaman" ishlamaydi, sahifalash
> majburiy.

### Cheksiz ro'yxat (infinite scroll)

`offset` ni oshirib boring: `0`, `50`, `100`... `page.hasMore` `false` bo'lguncha.

Ba'zi endpointlarda `cursor` ham bor — u tez o'zgaradigan ro'yxatlarda (sotuvlar
tarixi) yaxshiroq, chunki yangi yozuv qo'shilganda sahifalar siljib ketmaydi.
Kerak bo'lsa `offset` o'rniga ishlating — ikkalasini birga emas.

---

## 7. Idempotency-Key — pul harakatlanadigan endpointlar

**Oltita endpoint bu sarlavhani majburiy talab qiladi:**

```http
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

| Endpoint | Nima qiladi |
|---|---|
| `POST /sales/checkout` | Sotuvni yakunlaydi |
| `POST /returns` | Qaytarish qabul qiladi |
| `POST /exchanges` | Almashtiradi |
| `POST /debts/payments` | Mijozdan qarz undiradi |
| `POST /suppliers/payments` | Yetkazib beruvchiga to'laydi |
| `POST /purchases/:id/receive` | Xaridni qabul qiladi |

### Nega kerak

Kassir "Sotish" tugmasini bosdi, internet uzildi, javob kelmadi. Kassir yana
bosdi. **Idempotency-Key bo'lmasa — ikkita sotuv, ikki marta yechilgan qoldiq,
ikki marta yozilgan qarz.**

Kalit bilan esa: ikkinchi so'rov **birinchisining javobini** qaytaradi. Yangi
sotuv yaratilmaydi.

### Qanday ishlatiladi

1. Foydalanuvchi tugmani bosganda **bitta UUID v4** yarating
2. Uni so'rov bilan yuboring
3. **Xato bo'lsa va qayta urinsangiz — o'sha kalitni yuboring**, yangisini emas
4. Amal muvaffaqiyatli tugagandan keyingina kalitni tashlang

> Dart'da: `uuid` paketi, `const Uuid().v4()`.

**Muhim:** kalitni ekran ochilganda emas, **tugma bosilganda** yarating va
so'rov to'liq tugagunicha saqlang. Ekran har qayta chizilganda yangi kalit
yaratilsa — himoya ishlamaydi.

### Kutilishi mumkin bo'lgan javoblar

| `code` | Ma'nosi |
|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` | Sarlavha yuborilmadi yoki UUID v4 emas |
| `REQUEST_IN_PROGRESS` | O'sha kalit bilan so'rov hozir bajarilyapti. Kuting |
| `IDEMPOTENCY_KEY_REUSED` | O'sha kalit **boshqa** ma'lumot bilan ishlatildi |

---

## 8. Sana va vaqt

Barcha vaqtlar **ISO-8601, UTC**:

```json
"completedAt": "2026-09-29T10:36:22.932Z"
```

Ko'rsatishda mahalliy vaqtga o'tkazing — O'zbekiston UTC+5, yozgi vaqt yo'q.

### "Biznes kuni" tushunchasi

Hisobotlarda kun **do'konning vaqt mintaqasi bo'yicha** hisoblanadi, UTC bo'yicha
emas. Soat 00:30 da urilgan chek — o'sha kechqurungi savdoga kiradi.

Ya'ni `/reports/sales` dagi `byDay[].date` ni **o'z mintaqangizga qayta
o'tkazmang** — u allaqachon do'kon kuni. Shunchaki ko'rsating.

---

## 9. Har bir javobdagi `X-Request-Id`

Har bir javobda shu sarlavha bo'ladi. Xato bo'lganda `traceId` ham shu qiymat.

**Ilova uni log'ga yozib borsin.** Muammo bo'lganda serverdagi log'ni shu ID
bo'yicha topish mumkin — bu qo'llab-quvvatlashni soatlab qidiruvdan qutqaradi.

Xohlasangiz o'zingiz ham yuborishingiz mumkin (`X-Request-Id` sarlavhasida) —
server uni qabul qiladi va o'sha ID bilan ishlaydi.

---

## 10. Limitlar

| Nima | Limit |
|---|---|
| Oddiy so'rovlar | 600 / daqiqa |
| Kirish (`/auth/login`, `/auth/refresh`, parol o'zgartirish) | **5 / 15 daqiqa** |
| So'rov tanasi | 1 MB |

Kirish limiti qattiq — parol tanlashga qarshi. Ilovada login tugmasini so'rov
ketayotganda o'chirib qo'ying, aks holda foydalanuvchi bir necha marta bosib
o'zini bloklaydi.

`429` kelganda: kuting va qayta urinib ko'ring. Ekranda "Juda ko'p urinish.
Bir ozdan keyin qayta urinib ko'ring" deb yozing.

---

## 11. CORS va mobil ilova

**Mobil ilovaga CORS tegishli emas.** Flutter (Android/iOS) `Origin` sarlavhasi
yubormaydi, shuning uchun hech qanday sozlash kerak emas.

Faqat **Flutter Web** ishlatsangiz — ilovangiz manzili serverdagi ruxsat
ro'yxatiga qo'shilishi kerak. Bu holda ayting, qo'shib qo'yamiz.

---

## 12. Xulosa — ilovaning HTTP qatlami nimalarni qilishi kerak

Bu ro'yxat bo'yicha tekshirib chiqing:

- [ ] Base URL bitta joyda saqlanadi (konfiguratsiya)
- [ ] Har bir so'rovga `Authorization: Bearer` qo'shiladi
- [ ] `401` + `TOKEN_EXPIRED` kelganda avtomatik refresh, keyin so'rov takrorlanadi
- [ ] Refresh **navbatda**, bir vaqtda bittadan ortiq emas
- [ ] Refresh ham muvaffaqiyatsiz bo'lsa — login ekraniga
- [ ] Xato javobi RFC 9457 modeliga parse qilinadi (`code`, `detail`, `traceId`)
- [ ] Pul `int`, miqdor `String`
- [ ] Ro'yxatlar `{data, page}` konvertidan chiqariladi
- [ ] Oltita endpointga `Idempotency-Key` qo'shiladi
- [ ] `X-Request-Id` log'ga yoziladi
- [ ] Tarmoq yo'qligi alohida ishlanadi (server xatosi emas)

---

**Keyingi:** [02-auth.md](02-auth.md) — kirish va sessiya.
