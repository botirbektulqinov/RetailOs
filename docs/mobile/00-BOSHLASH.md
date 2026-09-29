# RetailOS Mobile — API hujjatlari

Bu papka RetailOS backend API'sini **Flutter ilovasi uchun** tushuntiradi.
Har bir fayl — bitta bosqich. Ketma-ket o'qiladi, ketma-ket bajariladi.

---

## Ilova nima qiladi

RetailOS — O'zbekiston chakana savdosi uchun do'kon boshqaruv tizimi. Mobil
ilova asosan **kassir va menejer** uchun: sotuv rasmiylashtirish, mahsulot
qidirish, shtrix-kod skanerlash, qarzga berish, qaytarish qabul qilish, smena
ochish-yopish va kunlik hisobotni ko'rish.

Server tomoni **to'liq tayyor** — 105 ta endpoint, 513 ta integratsion test.
Mobil ilova hech qanday biznes-mantiqni takrorlamaydi: narx hisoblash, qoldiq
tekshirish, chegirma qo'llash, qarz yozish — hammasi serverda. Ilovaning vazifasi
ma'lumotni **ko'rsatish va yuborish**.

---

## Manzillar

| | |
|---|---|
| **Base URL** | `https://api.finmates.app/api/v1` |
| **Swagger** | `https://api.finmates.app/api/docs` (login/parol so'raydi) |
| **OpenAPI JSON** | `https://api.finmates.app/api/docs/json` |

Swagger — jonli. Har qanday endpointni brauzerda sinab ko'rish mumkin: avval
`/auth/login` dan token oling, yuqoridagi **Authorize** tugmasiga qo'ying, keyin
istalgan endpointda "Try it out".

**Demo hisoblar** (test uchun, haqiqiy emas):

| Telefon | Parol | Rol |
|---|---|---|
| `+998901234567` | `RetailOS2026` | ADMIN — hamma narsa ochiq |
| `+998901234568` | `RetailOS2026` | MANAGER |
| `+998901234569` | `RetailOS2026` | CASHIER — kassir |
| `+998901234570` | `RetailOS2026` | WAREHOUSE — omborchi |

---

## Fayllar tartibi

**`01-asoslar.md` ni har doim birinchi o'qing.** Unda pul, miqdor, xato va
sahifalash qoidalari bor — ular barcha endpointlarga tegishli va bir marta
o'rganiladi. Qolgan fayllar shu qoidalarni takrorlamaydi.

| # | Fayl | Nima haqida | Muhimlik |
|---|---|---|---|
| 01 | [asoslar](01-asoslar.md) | Pul, miqdor, xato, sahifalash, idempotentlik | **Majburiy** |
| 02 | [auth](02-auth.md) | Kirish, token, sessiya, do'kon tanlash | **Majburiy** |
| 03 | [katalog](03-katalog.md) | Mahsulot, variant, kategoriya, shtrix-kod | **Asosiy** |
| 04 | [ombor](04-ombor.md) | Qoldiq, harakatlar, kam qolganlar | **Asosiy** |
| 05 | [savdo](05-savdo.md) | POS, checkout, to'lov, chek | **Asosiy — yurak** |
| 06 | [mijozlar](06-mijozlar.md) | Mijozlar, qarz, to'lovlar | Asosiy |
| 07 | [qaytarish](07-qaytarish.md) | Qaytarish, almashtirish, refund | Asosiy |
| 08 | [kassa](08-kassa.md) | Smena, kassa harakati, Z-hisobot | Asosiy |
| 09 | [aksiya-loyalty](09-aksiya-loyalty.md) | Chegirma, aksiya, ball | Qo'shimcha |
| 10 | [hisobot](10-hisobot.md) | Dashboard va hisobotlar | Qo'shimcha |
| 11 | [taminot](11-taminot.md) | Yetkazib beruvchi, xarid | Qo'shimcha |
| 12 | [xodimlar](12-xodimlar.md) | Xodimlar, rollar, do'konlar | Qo'shimcha |

---

## AI bilan ishlash tartibi

Bu hujjatlar AI yordamchisiga (Claude, Codex, Gemini) berish uchun yozilgan.
Tavsiya etiladigan usul:

1. **Har safar `01-asoslar.md` + o'sha bosqich faylini** bering. Hammasini
   bittada bermang — kontekst to'lib ketadi va AI aralashtirib yuboradi.
2. Bosqichni tugatmasdan keyingisiga o'tmang. `05-savdo.md` `03` va `04` ga
   tayanadi; tartibni buzsangiz AI mavjud bo'lmagan ma'lumotni o'ylab topadi.
3. AI'ga aytilishi kerak: **"Biznes-mantiqni mijoz tomonida takrorlama.
   Narxni, chegirmani, qoldiqni o'zing hisoblama — serverdan kelganini
   ko'rsat."**

---

## Eng ko'p uchraydigan xatolar

Quyidagilar — bu API bilan ishlaganda AI ham, odam ham eng ko'p qiladigan
xatolar. Boshidan biling:

**1. Pulni `double` qilib olish.** Pul — butun son, so'mning eng kichik
birligida. `450000` = 450 000 so'm. `double` ishlatsangiz katta summalarda
aniqlik yo'qoladi va kassa hisobi chiqmay qoladi. Batafsil: `01-asoslar.md`.

**2. Miqdorni `double` qilib yuborish.** Miqdor — **satr**, 3 ta kasr xonasi
bilan: `"1.500"`. `1.5` emas, `"1.5"` ham emas — aynan `"1.500"`.

**3. Chekni mijoz tomonida hisoblash.** Jamini, chegirmani, soliqni ilovada
hisoblab, keyin serverga yubormang. Server yuborilgan jamini **umuman
o'qimaydi** — o'zi hisoblaydi va o'z natijasini qaytaradi. Ekranda faqat
serverning javobini ko'rsating.

**4. Xatoni `detail` matni bo'yicha ushlash.** `detail` — odamga mo'ljallangan
matn, o'zgarishi mumkin. Har doim `code` ga qarang.

**5. `Idempotency-Key` ni unutish.** Oltita endpoint uni **majburiy** talab
qiladi. Bo'lmasa 400 qaytadi. Qaysilari — `01-asoslar.md` da.

**6. Token yangilashni navbatga qo'ymaslik.** Access token 15 daqiqa yashaydi.
Bir vaqtda 5 ta so'rov 401 olsa va beshtasi ham refresh qilsa — sessiya buziladi.
Refresh bitta bo'lishi kerak. `02-auth.md` da tushuntirilgan.

---

## Muhim tamoyil

> **Server — yagona haqiqat manbai.**
>
> Bu tizimda pul, qoldiq, qarz va ball — hammasi **jurnal (ledger)** asosida
> ishlaydi. Har bir o'zgarish yozib boriladi va tekshirib chiqilishi mumkin.
> Mijoz tomoni hech qachon "hisoblab qo'yib, keyin serverga aytadigan" rolda
> emas. Ilova so'raydi — server hal qiladi — ilova natijani ko'rsatadi.
>
> Shuning uchun offline rejim ham oddiy emas va bu bosqichda ko'zda tutilmagan.
> Ilova internetsiz ishlashi kerak bo'lsa — alohida muhokama qilinadi.
