import { db } from "@/db";
import { openai } from "@/lib/openai";
import { getPineconeClient } from "@/lib/pinecone";
import { SendMessageValidator } from "@/lib/validators/SendMessageValidator";
import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { PineconeStore } from "langchain/vectorstores/pinecone";
import { NextRequest } from "next/server";
import { OpenAIStream, StreamingTextResponse } from "ai";

export const POST = async (req: NextRequest) => {
  const body = await req.json();
  const { getUser } = getKindeServerSession();
  const user = getUser();
  const { id: userId } = user;

  if (!userId) return new Response("Unauthorized", { status: 401 });

  const { fileId, message } = SendMessageValidator.parse(body);
  const file = await db.file.findFirst({ where: { id: fileId, userId } });
  if (!file) return new Response("Not found", { status: 404 });

  await db.message.create({
    data: { text: message, isUserMessage: true, userId, fileId },
  });

  const embeddings = new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
  const pinecone = await getPineconeClient();
  const pineconeIndex = pinecone.Index("brite");
  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    namespace: file.id,
  });
  const results = await vectorStore.similaritySearch(message, 4);
  const prevMessages = await db.message.findMany({
    where: { fileId },
    orderBy: { createdAt: "asc" },
    take: 6,
  });
  const formattedPrevMessages = prevMessages.map((msg) => ({
    role: msg.isUserMessage ? ("user" as const) : ("assistant" as const),
    content: msg.text,
  }));

  const documentContext = results.map((r) => r.pageContent);
  const dynamicPrompt = createDynamicPrompt(
    message,
    formattedPrevMessages,
    documentContext
  );

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    temperature: 0,
    stream: true,
    messages: [
      { role: "system", content: dynamicPrompt },
      { role: "user", content: message },
    ],
  });

  const stream = OpenAIStream(response, {
    async onCompletion(completion) {
      await processAIResponse(completion, fileId, userId);
    },
  });

  return new StreamingTextResponse(stream);
};

function createDynamicPrompt(message, prevMessages, documentContext) {
  let prompt = "Answer the user's question in markdown format.\n\n";
  if (documentContext.includes("business data")) {
    prompt += "Focus on analyzing the business data.\n\n";
  }
  prompt += "Document Context:\n" + documentContext.join("\n\n") + "\n\n";
  prompt += "Previous Conversation:\n";
  prevMessages.forEach((msg) => {
    prompt += `${msg.role === "user" ? "User:" : "Assistant:"} ${
      msg.content
    }\n`;
  });
  prompt += "\nUser Query:\n" + message;
  return prompt;
}

async function processAIResponse(aiResponse, fileId, userId) {
  if (aiResponse.includes("Clarification needed:")) {
    const clarificationQuestion = aiResponse
      .split("Clarification needed:")[1]
      .trim();
    // Send clarification question back to the user
  } else if (aiResponse.includes("I am not certain,")) {
    aiResponse +=
      "\nWould you like to search for this information in external databases?";
  }
  await db.message.create({
    data: { text: aiResponse, isUserMessage: false, fileId, userId },
  });
}
