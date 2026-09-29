# 02 — Kirish va sessiya

> Oldin o'qing: [01-asoslar.md](01-asoslar.md)

Bu bosqich ilovaning poydevori. **Butun ilova shu qatlamga tayanadi** — keyingi
hech bir ekran token boshqaruvi to'g'ri ishlamaguncha ishlamaydi.

---

## Endpointlar

| Metod | Yo'l | Token kerakmi | Nima qiladi |
|---|---|---|---|
| `POST` | `/auth/login` | **yo'q** | Kirish |
| `POST` | `/auth/refresh` | **yo'q** | Sessiyani yangilash |
| `GET` | `/auth/me` | ha | Joriy foydalanuvchi |
| `POST` | `/auth/switch-store` | ha | Do'konni almashtirish |
| `POST` | `/auth/logout` | ha | Joriy sessiyadan chiqish |
| `POST` | `/auth/logout-all` | ha | Barcha qurilmalardan chiqish |
| `POST` | `/auth/change-password` | ha | Parolni almashtirish |
| `GET` | `/auth/sessions` | ha | Faol qurilmalar ro'yxati |
| `DELETE` | `/auth/sessions/:id` | ha | Bitta qurilmani chiqarish |

---

## 1. Kirish

### `POST /auth/login`

```json
{
  "phone": "+998 90 123 45 67",
  "password": "RetailOS2026",
  "rememberDevice": true,
  "storeId": null
}
```

| Maydon | Majburiy | Izoh |
|---|---|---|
| `phone` | ha | **Istalgan formatda**. Server o'zi E.164 ga keltiradi — `+998901234567`, `90 123 45 67`, `(90) 123-45-67` hammasi ishlaydi. Ilovada maska qo'ying, lekin tozalab yuborish shart emas |
| `password` | ha | |
| `rememberDevice` | yo'q | Login ekranidagi "Eslab qolish". `true` → refresh token 30 kun, `false`/berilmasa → **12 soat** |
| `storeId` | yo'q | Qaysi do'konga kirish. Berilmasa asosiy (primary) do'kon tanlanadi |

### Javob — `200`

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "a7f3c2e1...",
  "expiresIn": 900,
  "user": {
    "id": "uuid",
    "fullName": "Dilshod Karimov",
    "phone": "+998901234567",
    "email": null,
    "status": "ACTIVE",
    "organization": {
      "id": "uuid",
      "name": "Navro'z Market",
      "currencyCode": "UZS",
      "status": "ACTIVE"
    },
    "activeStore": { "id": "uuid", "code": "S1", "name": "Markaziy do'kon" },
    "stores": [
      { "id": "uuid", "code": "S1", "name": "Markaziy do'kon", "roleCode": "ADMIN", "roleName": "Administrator" }
    ],
    "role": { "id": "uuid", "code": "ADMIN", "name": "Administrator" },
    "permissions": ["sales.create", "sales.read", "inventory.adjust", "..."]
  }
}
```

`expiresIn` — **soniyalarda** (900 = 15 daqiqa). Bu access token muddati.

### Xatolar

| HTTP | `code` | Ekranda |
|---|---|---|
| `401` | `INVALID_CREDENTIALS` | "Telefon raqami yoki parol noto'g'ri" |
| `403` | `USER_INACTIVE` | "Hisobingiz faol emas. Administratorga murojaat qiling" |
| `403` | `ORGANIZATION_SUSPENDED` | "Tashkilot vaqtincha to'xtatilgan" |
| `403` | `NO_STORE_ACCESS` | "Sizga hech qanday do'kon biriktirilmagan" |
| `403` | `STORE_ACCESS_DENIED` | Tanlangan do'konga a'zo emas |
| `429` | `RATE_LIMIT_EXCEEDED` | "Juda ko'p urinish. 15 daqiqadan keyin qayta urinib ko'ring" |

> **Diqqat:** noto'g'ri telefon va noto'g'ri parol uchun javob **bir xil**
> (`INVALID_CREDENTIALS`). Bu ataylab qilingan — aks holda kimdir qaysi raqamlar
> ro'yxatdan o'tganini bilib olardi. Ilovada ham "bunday raqam yo'q" deb
> ajratib ko'rsatmang.

> **Login tugmasi:** so'rov ketayotganda **o'chirib qo'ying**. Limit 15 daqiqada
> 5 ta — foydalanuvchi bir necha marta bosib o'zini bloklaydi.

---

## 2. Tokenlar qanday ishlaydi

```
Access token    15 daqiqa   →  har bir so'rovga qo'shiladi
Refresh token   30 kun      →  faqat /auth/refresh ga yuboriladi
                12 soat        (rememberDevice = false bo'lsa)
```

### Saqlash

**Ikkalasi ham `flutter_secure_storage` da saqlanadi.** `SharedPreferences`
ishlatmang — u shifrlanmaydi va root qilingan qurilmada ochiq o'qiladi.

### `/auth/refresh` — rotatsiya

```json
{ "refreshToken": "a7f3c2e1..." }
```

Javob — `login` bilan **bir xil shakl**: yangi `accessToken`, **yangi
`refreshToken`**, `expiresIn`, `user`.

> **Har refresh'da refresh token ham almashadi.** Eskisi darhol bekor bo'ladi.
> Yangisini saqlashni unutmang — aks holda keyingi refresh ishlamaydi.

### O'g'irlangan token himoyasi

Bekor qilingan refresh token qayta ishlatilsa, server buni **o'g'irlik alomati**
deb hisoblaydi va **o'sha sessiyaning butun zanjirini** bekor qiladi.

Amalda bu shuni anglatadi: agar ilova eski tokenni saqlab qolib qayta yuborsa,
foydalanuvchi **to'satdan chiqib ketadi**. Shuning uchun:

- Yangi tokenni **darhol** saqlang, so'rov tugashi bilan
- Ikkita refresh bir vaqtda ketmasin (pastda)

### Refresh navbati — eng muhim qism

Ilovada 5 ta so'rov bir vaqtda ketdi va beshtasi ham `401` oldi. Agar beshtasi
ham refresh qilsa:

```
So'rov 1 → refresh(A) → token B beradi, A bekor
So'rov 2 → refresh(A) → A bekor qilingan! → BUTUN SESSIYA YOPILADI
```

Foydalanuvchi sababsiz chiqib ketadi.

**To'g'ri yechim:** refresh bir vaqtda faqat bitta bo'lsin. Birinchi `401` refresh
boshlaydi, qolganlari **o'shanga kutib turadi**, keyin hammasi yangi token bilan
takrorlanadi.

Dart'da bu odatda `Completer` yoki `Future` ni saqlab qo'yish orqali qilinadi:
agar refresh allaqachon ketayotgan bo'lsa — yangisini boshlamay, o'sha `Future`
ni qaytarish. `dio` ishlatsangiz, `QueuedInterceptor` aynan shu uchun bor.

### So'rov oqimi

```
So'rov yuboriladi
  ├─ 200 → ishlaydi
  └─ 401
       ├─ code = TOKEN_EXPIRED
       │    ├─ refresh navbatda ketyapti? → kutamiz
       │    ├─ yo'q? → refresh boshlaymiz
       │    ├─ refresh muvaffaqiyatli → tokenlarni saqlash → so'rovni TAKRORLASH
       │    └─ refresh ham 401 → tokenlarni o'chirish → login ekraniga
       └─ code = TOKEN_INVALID → to'g'ridan-to'g'ri login ekraniga
```

> **Takrorlash faqat bir marta.** Takrorlangan so'rov yana `401` bersa —
> login ekraniga. Aks holda cheksiz halqa hosil bo'ladi.

---

## 3. Token kutilmaganda bekor bo'ladigan holatlar

Bular **oddiy** holatlar, xato emas. Ilova ularga tayyor bo'lishi kerak —
foydalanuvchi keyingi so'rovda `401` oladi:

| Nima bo'ldi | Natija |
|---|---|
| Administrator parolni tiklab berdi | Barcha sessiyalar yopiladi |
| Administrator do'kon biriktirmasini o'zgartirdi | Token bekor |
| Administrator rolning ruxsatlarini o'zgartirdi | Token bekor |
| Foydalanuvchi "Barcha qurilmalardan chiqish" bosdi | Hammasi yopiladi |
| Foydalanuvchi parolni o'zgartirdi | **Joriy sessiya ham** yopiladi |
| Hisob o'chirildi (deaktivatsiya) | Token bekor |

Ular hammasi `401` bilan keladi. Ilova login ekraniga qaytaradi va
**"Sessiya tugadi, qayta kiring"** deb ko'rsatadi — "xato yuz berdi" emas.

---

## 4. `GET /auth/me`

Login javobidagi `user` bilan **bir xil shakl** qaytaradi.

Qachon chaqiriladi:

- **Ilova ishga tushganda**, saqlangan token bilan — token hali amal qiladimi
  va foydalanuvchi ma'lumoti o'zgarmaganmi, shuni tekshiradi
- Profil ekrani ochilganda
- Do'kon almashtirilgandan keyin

> Har bir ekranda chaqirmang. Javob kamdan-kam o'zgaradi — bir marta olib,
> xotirada (state) saqlang.

---

## 5. Ruxsatlar (`permissions`) — UI'ni shunga qurish

`user.permissions` — foydalanuvchiga ruxsat etilgan amallar ro'yxati:

```json
["sales.create", "sales.read", "customers.read", "cash.open_shift", "..."]
```

### Qoida

**Foydalanuvchi bajara olmaydigan tugmani ko'rsatmang.** Bosib `403` olgandan
ko'ra — tugma umuman bo'lmagani yaxshi.

Eng ko'p kerak bo'ladiganlari:

| Ruxsat | Nimani ochadi |
|---|---|
| `sales.create` | Sotish tugmasi, POS ekrani |
| `sales.read` | Sotuvlar tarixi |
| `sales.discount` | Chegirma kiritish maydoni |
| `sales.refund` | Qaytarish qabul qilish |
| `sales.cancel` | Sotuvni bekor qilish |
| `debt.create` | Qarzga sotish |
| `debt.collect` | Qarz undirish |
| `inventory.read` | Ombor qoldiqlari |
| `inventory.adjust` | Qoldiqni tuzatish |
| `cash.open_shift` / `cash.close_shift` | Smena ochish / yopish |
| `cash.movement` | Kassadan pul chiqarish — **odatda faqat menejerda** |
| `reports.read` | Hisobot va dashboard |
| `customers.manage` | Mijoz qo'shish/tahrirlash |

> **Muhim:** `permissions` da `*` **hech qachon bo'lmaydi.** Administratorda ham
> u kengaytirilgan holda — barcha konkret ruxsatlar ro'yxati sifatida keladi.
> Ya'ni `permissions.contains('*')` deb tekshirmang, hech qachon ishlamaydi.

> **Ruxsat tekshiruvi — faqat UI uchun.** Xavfsizlikni server ta'minlaydi.
> Ilovadagi tekshiruv qulaylik uchun, himoya uchun emas.

---

## 6. Ko'p do'konli ishlash

Bitta foydalanuvchi bir nechta do'konda ishlashi mumkin va **har birida boshqa
rolda** — masalan markazda MANAGER, filialda CASHIER.

`user.stores` — u a'zo bo'lgan do'konlar. `user.activeStore` — hozir qaysinisida.

### `POST /auth/switch-store`

```json
{ "storeId": "uuid" }
```

Javob:

```json
{
  "accessToken": "yangi-token...",
  "expiresIn": 900,
  "user": { "...": "activeStore va role yangilangan" }
}
```

| Nuqta | Izoh |
|---|---|
| **Faqat `accessToken` yangilanadi** | `refreshToken` o'zgarmaydi — saqlanganini qoldiring |
| Rol ham o'zgarishi mumkin | Yangi do'konda boshqa rol bo'lsa `permissions` ham o'zgaradi → **UI'ni qayta chizing** |
| Do'kon token ichida | Mijoz uni o'zgartira olmaydi. `storeId` ni so'rovlarga qo'lda qo'shish shart emas |

Xato: `403 STORE_ACCESS_DENIED` — bu do'konga a'zo emas.

> Do'kon almashtirilganda **mahalliy keshni tozalang**: mahsulot qoldig'i,
> savat, sotuvlar tarixi — hammasi do'konga bog'liq.

> `user.stores` da bitta do'kon bo'lsa — almashtirish tugmasini ko'rsatmang.

---

## 7. Parolni almashtirish

### `POST /auth/change-password`

```json
{
  "currentPassword": "EskiParol123",
  "newPassword": "YangiParol456"
}
```

Javob: **`204 No Content`** — tana bo'sh.

**Muvaffaqiyatli almashtirilgandan keyin barcha sessiyalar yopiladi — joriysi
ham.** Ya'ni ilova darhol login ekraniga qaytishi va foydalanuvchidan yangi
parol bilan kirishni so'rashi kerak. Bu ataylab: parol o'zgartirilyapti degani —
u oshkor bo'lgan deb hisoblanadi.

### Parol talablari

- Kamida **8 ta belgi**
- Kamida bitta **raqam yoki maxsus belgi**

Ilovada shu qoidalarni real vaqtda ko'rsating, lekin serverni ham tekshirsin —
u yagona haqiqat.

Xatolar:

| `code` | Ma'nosi |
|---|---|
| `INVALID_CREDENTIALS` | Joriy parol noto'g'ri |
| `WEAK_PASSWORD` | Yangi parol talablarga javob bermaydi |

---

## 8. Chiqish

### `POST /auth/logout`

```json
{ "refreshToken": "a7f3c2e1..." }
```

`refreshToken` ni **albatta yuboring**. Yubormasangiz sessiya serverda ochiq
qoladi va "Faol qurilmalar" ro'yxatida osilib turadi.

Javob `200`. **Bir necha marta chaqirish xavfsiz** — takroriy chaqiruv ham `200`
qaytaradi, xato bermaydi.

> Server javobini kutmasdan ham mahalliy tokenlarni **darhol o'chiring**.
> Internet yo'q bo'lsa ham foydalanuvchi chiqa olishi kerak.

### `POST /auth/logout-all`

Tanasi yo'q. Barcha qurilmalardagi sessiyalarni yopadi.

---

## 9. Faol qurilmalar

### `GET /auth/sessions`

```json
[
  {
    "id": "uuid",
    "deviceName": "Xiaomi Redmi Note 12",
    "ip": "202.79.186.155",
    "lastUsedAt": "2026-09-29T10:11:08.000Z",
    "createdAt": "2026-09-28T14:22:00.000Z",
    "expiresAt": "2026-10-28T14:22:00.000Z"
  }
]
```

> Bu endpoint **konvertsiz** — to'g'ridan-to'g'ri massiv qaytaradi, `{data, page}`
> emas. Ro'yxat kichik, sahifalash kerak emas.

`deviceName` noma'lum bo'lsa `"Noma'lum qurilma"` keladi.

### `DELETE /auth/sessions/:id`

Bitta qurilmani chiqaradi. Javob `204`.

Joriy sessiyani o'chirsa — foydalanuvchi o'zini chiqarib yuboradi. Ilovada
joriy qurilmani belgilab ("Bu qurilma") va o'chirishdan oldin tasdiq so'rang.

---

## 10. Bu bosqich tugadi deyish uchun

- [ ] Login ekrani ishlaydi, telefon maskasi bor
- [ ] "Eslab qolish" checkbox `rememberDevice` ga ulangan
- [ ] Tokenlar `flutter_secure_storage` da
- [ ] Har bir so'rovga `Authorization` avtomatik qo'shiladi
- [ ] `401` + `TOKEN_EXPIRED` → refresh → so'rov takrorlanadi
- [ ] **Refresh navbatda, bir vaqtda bitta**
- [ ] Takrorlash faqat bir marta, cheksiz halqa yo'q
- [ ] Refresh muvaffaqiyatsiz → tokenlar o'chiriladi → login ekrani
- [ ] Ilova ishga tushganda `/auth/me` bilan token tekshiriladi
- [ ] `permissions` state'da saqlanadi, UI shunga qarab chiziladi
- [ ] Ko'p do'kon bo'lsa almashtirish ishlaydi va **kesh tozalanadi**
- [ ] Parol almashtirilgandan keyin login ekraniga qaytadi
- [ ] Chiqish mahalliy tokenlarni tarmoqdan qat'i nazar o'chiradi
- [ ] "Faol qurilmalar" ekrani ishlaydi
- [ ] Login tugmasi so'rov ketayotganda o'chadi

---

**Keyingi:** [03-katalog.md](03-katalog.md) — mahsulot, variant, shtrix-kod.
