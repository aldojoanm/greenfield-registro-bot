import fetch from "node-fetch";

const TOKEN = "EAAVCwXLXOUABPeWd9nU8GEZBsfylX2hYGzNedhESRZC4TgTwK3PflpiZC0nrQaljZAVEHZBpAYlBVAy0V5DG3LJgfv2jMqMFD1d1ZCuyv9jWoceLr2YWlZCiRILviQ7nGt4i8hpDRcHtrLmnL2Se8q5mswa6voYBw17eZC4mRADaUTy68O2k3JZBZCpQkweQgZA1siZB7wZDZD";         // exporta antes tu token
const PHONE_NUMBER_ID = "758477090684014";
const TO = "59170400175";                         // destino E.164 sin '+'

const body = {
  messaging_product: "whatsapp",
  to: TO,
  type: "template",
  template: { name: "hello_world", language: { code: "en_US" } }
};

const r = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
console.log("status:", r.status);
console.log(await r.text());
