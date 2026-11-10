import '../config/env.js';
import bcrypt from 'bcryptjs';
import { connectDatabase } from '../services/database.service.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import BusinessSettings from '../models/BusinessSettings.js';

const isProduction = process.env.NODE_ENV === 'production';
const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
const printCredentials = process.env.SEED_PRINT_CREDENTIALS === 'true';
const demoEnabled = !isProduction && process.env.SEED_DEMO === 'true';

await connectDatabase();
await Promise.all([
  User.deleteMany({}),
  Customer.deleteMany({}),
  Conversation.deleteMany({}),
  Message.deleteMany({}),
  BusinessSettings.deleteMany({}),
]);

// Configured credentials always win. ADMIN_EMAIL + ADMIN_PASSWORD from the
// environment create (or update, by email) the production admin. The demo
// admin is only created in development when explicitly enabled via
// SEED_DEMO=true, and never alongside/handle-away configured credentials.
async function upsertAdmin(email, password, name, role) {
  const passwordHash = await bcrypt.hash(password, 12);
  return User.findOneAndUpdate(
    { email },
    { $set: { name, role, passwordHash } },
    { upsert: true, new: true, runValidators: true },
  );
}

if (adminEmail && adminPassword) {
  await upsertAdmin(adminEmail, adminPassword, 'Administrator', 'ADMIN');
  console.log(`Seeded admin user: ${adminEmail}`);
  if (printCredentials) console.log(`Admin password: ${adminPassword}`);
} else if (demoEnabled) {
  await upsertAdmin('admin@customer-ai.test', 'ChangeMe123!', 'Adwoa Mensah', 'ADMIN');
  console.log('Seeded demo admin user: admin@customer-ai.test (development mode only)');
  if (printCredentials) console.log('Demo admin password: ChangeMe123!');
} else {
  console.log(
    isProduction
      ? 'No admin seeded. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then run `npm run seed --prefix server`.'
      : 'No admin seeded. Set ADMIN_EMAIL and ADMIN_PASSWORD, or enable SEED_DEMO=true (development only), then run `npm run seed --prefix server`.',
  );
}

// Fixture/demo data only in non-production.
if (!isProduction) {
  await BusinessSettings.create({
    businessName: 'Check Check City',
    description: 'Small fast-food shop in Ghana owned by Kofi. Customers place their orders over WhatsApp. All prices are in Ghanaian cedis (GH₵) and every item is sold per pack.',
    location: 'Not confirmed yet — refer customers to Kofi (the owner).',
    openingHours: 'Not confirmed yet — refer customers to Kofi (the owner).',
    productsServices: 'Our menu has exactly three items, each sold per pack:\n1. Jollof Rice\n2. Fried Rice\n3. Noodles\nThese three items are the only food items we have confirmed information about.',
    prices: 'Jollof Rice — GH₵30 per pack\nFried Rice — GH₵30 per pack\nNoodles — GH₵30 per pack\nEvery pack of any item on the menu costs GH₵30. An order total is GH₵30 multiplied by the number of packs (for example: 2 packs of Jollof Rice + 1 pack of Noodles = GH₵60 + GH₵30 = GH₵90). No other prices, fees, or discounts are confirmed.',
    deliveryInformation: 'Not confirmed — we have no confirmed delivery details. Refer the customer to Kofi (the owner) or a human representative.',
    paymentInformation: 'Not confirmed — we have no confirmed payment details. Refer the customer to Kofi (the owner) or a human representative.',
    commonQuestions: 'Q: What food do you sell / What is on your menu?\nA: We currently have Jollof Rice, Fried Rice and Noodles — GH₵30 per pack each.\n\nQ: How much is a pack / How much is your jollof / How much is fried rice?\nA: Every pack costs GH₵30, whichever item the customer picks.\n\nQ: Do you sell drinks, pizza, burgers or other food that is not on the menu?\nA: We do not have confirmed information about anything that is not on the menu above, so we cannot confirm that it is available. A human representative (Kofi, the owner) will follow up.\n\nQ: Do you deliver? What is the delivery fee?\nA: Delivery and delivery fees are not confirmed. A human representative (Kofi, the owner) will assist.\n\nQ: Is [item] in stock right now?\nA: We do not have a reliable availability system, so we cannot confirm stock. A human representative will assist.\n\nQ: How do I pay / what payment methods do you accept?\nA: Payment method is not confirmed. A human representative (Kofi, the owner) will assist.',
    responseStyle: 'Reply in a friendly, warm and professional way, like the owner talking to a customer. If the customer only greets you, greet them briefly and ask how you can help; do not list the menu unless they ask what you sell or ask for the menu. When the customer asks for the menu, answer from the confirmed menu information only and show each item with its price clearly on its own line. Use one fitting emoji per menu item: 🍚 Jollof Rice, 🍛 Fried Rice, 🍜 Noodles. Keep replies short. When the customer says what they want to order or asks for a total, show the order itemised (each item with the quantity and its price), then the total, then ask whether they would like to proceed with the order. Never invent items, prices, delivery or payment details.',
  });

  const data = [
    ['John Mensah', '233201112233', 'I want a refund for my order.', 'HUMAN_REQUIRED', false, true],
    ['Ama Boateng', '233241234567', 'How much is a pack of jollof rice?', 'OPEN', true, false],
    ['Kwame Owusu', '233551234567', 'Hello, do you deliver to Tema?', 'OPEN', true, false],
    ['Esi Addo', '233271234567', 'I have a complaint about my delivery.', 'HUMAN_REQUIRED', false, true],
  ];

  for (const [name, phone, content, status, aiEnabled, requiresHuman] of data) {
    const customer = await Customer.create({ name, phone });
    const conversation = await Conversation.create({
      customerId: customer.id,
      status,
      aiEnabled,
      requiresHuman,
      lastMessageAt: new Date(),
    });
    await Message.create({
      conversationId: conversation.id,
      customerId: customer.id,
      content,
      direction: 'INBOUND',
      senderType: 'CUSTOMER',
      aiIntent: requiresHuman ? 'COMPLAINT' : 'GENERAL',
      aiConfidence: requiresHuman ? 0.95 : 0.9,
    });
    if (aiEnabled) {
      await Message.create({
        conversationId: conversation.id,
        customerId: customer.id,
        content: 'Thanks for your message. I am checking the approved business information for you.',
        direction: 'OUTBOUND',
        senderType: 'AI',
        aiConfidence: 0.9,
        aiIntent: 'GENERAL',
      });
    }
  }
}

console.log('Seeding complete.');
process.exit(0);