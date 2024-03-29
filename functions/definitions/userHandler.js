const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');
const { sendWhatsappTextMessage, markWhatsappMessageAsRead } = require('./common/sendWhatsappMessage');
const { USER_BOT_RESPONSES } = require('./common/constants');
const { mockDb } = require('./common/utils');
const { downloadWhatsappMedia, getHash } = require('./common/mediaUtils');

if (!admin.apps.length) {
  admin.initializeApp();
}

exports.userHandler = async function (message) {
  let from = message.from; // extract the phone number from the webhook payload
  let type = message.type;
  const db = admin.firestore()

  const responsesRef = db.doc('systemParameters/userBotResponses');
  const supportedTypesRef = db.doc('systemParameters/supportedTypes');
  const [responsesSnapshot, supportedTypesSnapshot] = await db.getAll(responsesRef, supportedTypesRef);

  const responses = responsesSnapshot.data();

  // check that message type is supported, otherwise respond with appropriate message
  const supportedTypes = supportedTypesSnapshot.get('whatsapp') ?? ["text", "image"];
  if (!supportedTypes.includes(type)) {
    sendWhatsappTextMessage("user", from, responses?.UNSUPPORTED_TYPE ?? USER_BOT_RESPONSES.UNSUPPORTED_TYPE, message.id)
    markWhatsappMessageAsRead("user", message.id);
    return
  }
  const messageTimestamp = new Timestamp(parseInt(message.timestamp), 0);
  switch (type) {
    case "text":
      // info on WhatsApp text message payload: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
      if (!message.text || !message.text.body) {
        break;
      }
      if (message.text.body.startsWith("/")) {
        handleSpecialCommands(message);
        break;
      }
      await newTextInstanceHandler(db, {
        text: message.text.body,
        timestamp: messageTimestamp,
        id: message.id || null,
        from: from || null,
        isForwarded: message?.context?.forwarded || null,
        isFrequentlyForwarded: message?.context?.frequently_forwarded || null
      });
      break;

    case "image":
      await newImageInstanceHandler(db, {
        text: message?.image?.caption || null,
        timestamp: messageTimestamp,
        id: message.id || null,
        mediaId: message?.image?.id || null,
        mimeType: message?.image?.mime_type || null,
        from: from || null,
        isForwarded: message?.context?.forwarded || null,
        isFrequentlyForwarded: message?.context?.frequently_forwarded || null
      })
      break;
  }
  markWhatsappMessageAsRead("user", message.id);
}

async function newTextInstanceHandler(db, {
  text: text,
  timestamp: timestamp,
  id: id,
  from: from,
  isForwarded: isForwarded,
  isFrequentlyForwarded: isFrequentlyForwarded
}) {
  let textMatchSnapshot = await db.collection('messages').where('type', '==', 'text').where('text', '==', text).get();
  let messageId;
  if (textMatchSnapshot.empty) {
    let writeResult = await db.collection('messages').add({
      type: "text", //Can be 'audio', 'button', 'document', 'text', 'image', 'interactive', 'order', 'sticker', 'system', 'unknown', 'video'. But as a start only support text and image
      category: "fake news", //Can be "fake news" or "scam"
      text: text, //text or caption
      firstTimestamp: timestamp, //timestamp of first instance (firestore timestamp data type)
      isPollStarted: false, //boolean, whether or not polling has started
      isAssessed: false, //boolean, whether or not we have concluded the voting
      truthScore: null, //float, the mean truth score
      isIrrelevant: null, //bool, if majority voted irrelevant then update this
      isScam: null,
      custom_reply: null, //string
    });
    messageId = writeResult.id;
  } else {
    if (textMatchSnapshot.size > 1) {
      functions.logger.log(`strangely, more than 1 device matches the query ${message.text.body}`);
    }
    messageId = textMatchSnapshot.docs[0].id;
  }
  const _ = await db.collection('messages').doc(messageId).collection('instances').add({
    source: "whatsapp",
    id: id || null, //taken from webhook object, needed to reply
    timestamp: timestamp, //timestamp, taken from webhook object (firestore timestamp data type)
    type: "text", //message type, taken from webhook object. Can be 'audio', 'button', 'document', 'text', 'image', 'interactive', 'order', 'sticker', 'system', 'unknown', 'video'.
    text: text, //text or caption, taken from webhook object 
    from: from, //sender phone number, taken from webhook object 
    isForwarded: isForwarded, //boolean, taken from webhook object
    isFrequentlyForwarded: isFrequentlyForwarded, //boolean, taken from webhook object
    isReplied: false,
  });
}

async function newImageInstanceHandler(db, {
  text: text,
  timestamp: timestamp,
  id: id,
  mediaId: mediaId,
  mimeType: mimeType,
  from: from,
  isForwarded: isForwarded,
  isFrequentlyForwarded: isFrequentlyForwarded
}) {
  const token = process.env.WHATSAPP_TOKEN;
  let filename;
  //get response buffer
  let buffer = await downloadWhatsappMedia(mediaId, mimeType);
  const hash = await getHash(buffer);
  let imageMatchSnapshot = await db.collection('messages').where('type', '==', 'image').where('hash', '==', hash).get();
  let messageId;
  if (imageMatchSnapshot.empty) {
    const storageBucket = admin.storage().bucket();
    filename = `images/${mediaId}.${mimeType.split('/')[1]}`
    const file = storageBucket.file(filename);
    const stream = file.createWriteStream();
    stream.on('error', (err) => {
      functions.logger.log(err);
    });

    stream.on('finish', () => {
      functions.logger.log(`${filename} has been uploaded`);
    });

    stream.end(buffer);
    let writeResult = await db.collection('messages').add({
      type: "image", //Can be 'audio', 'button', 'document', 'text', 'image', 'interactive', 'order', 'sticker', 'system', 'unknown', 'video'. But as a start only support text and image
      category: "fake news",
      text: text, //text or caption
      hash: hash,
      mediaId: mediaId,
      mimeType: mimeType,
      storageUrl: filename,
      firstTimestamp: timestamp, //timestamp of first instance (firestore timestamp data type)
      isPollStarted: false, //boolean, whether or not polling has started
      isAssessed: false, //boolean, whether or not we have concluded the voting
      truthScore: null, //float, the mean truth score
      isScam: null,
      isIrrelevant: null, //bool, if majority voted irrelevant then update this
      custom_reply: null, //string
    });
    messageId = writeResult.id;

  } else {
    if (imageMatchSnapshot.size > 1) {
      functions.logger.log(`strangely, more than 1 device matches the query ${message.text.body}`);
    }
    messageId = imageMatchSnapshot.docs[0].id;
  }
  const _ = await db.collection('messages').doc(messageId).collection('instances').add({
    source: "whatsapp",
    id: id || null, //taken from webhook object, needed to reply
    timestamp: timestamp, //timestamp, taken from webhook object (firestore timestamp data type)
    type: "image", //message type, taken from webhook object. Can be 'audio', 'button', 'document', 'text', 'image', 'interactive', 'order', 'sticker', 'system', 'unknown', 'video'.
    text: text, //text or caption, taken from webhook object 
    from: from, //sender phone number, taken from webhook object 
    hash: hash,
    mediaId: mediaId,
    mimeType: mimeType,
    isForwarded: isForwarded, //boolean, taken from webhook object
    isFrequentlyForwarded: isFrequentlyForwarded, //boolean, taken from webhook object
    isReplied: false,
  });
}

//remove for prod
function handleSpecialCommands(messageObj) {
  const command = messageObj.text.body.toLowerCase();
  if (command.startsWith('/')) {
    switch (command) {
      case '/mockdb':
        mockDb();
        return
      case '/getid':
        sendWhatsappTextMessage("user", messageObj.from, `${messageObj.id}`, messageObj.id)
        return

    }
  }
}