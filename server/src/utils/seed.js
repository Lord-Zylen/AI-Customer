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
    businessName: 'Aseda Foods',
    description: 'A fictional Ghanaian staple-food supplier.',
    location: 'Madina, Accra',
    openingHours: 'Mon–Sat, 8:00 AM–6:00 PM',
    productsServices: 'Maize, rice, beans and cooking oil.',
    prices: '50kg maize bag: GH₵250. Premium rice 5kg: GH₵118.',
    deliveryInformation: 'Delivery is available in Accra. A team member confirms the fee before delivery.',
    paymentInformation: 'Payment details are confirmed by a team member.',
    commonQuestions: 'Ask a human when product availability or delivery fees are not listed.',
  });

  const data = [
    ['John Mensah', '233201112233', 'I want a refund for my order.', 'HUMAN_REQUIRED', false, true],
    ['Ama Boateng', '233241234567', 'How much is the 50kg maize bag?', 'OPEN', true, false],
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