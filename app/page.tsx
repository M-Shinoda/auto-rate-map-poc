import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-8 py-32 px-16 bg-white dark:bg-black">
        <h1 className="text-4xl font-bold text-black dark:text-zinc-50">
          バス運行データビューワー
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400 text-center">
          バスの運行情報をマップ上で可視化します
        </p>
        <div className="flex gap-4">
          <Link
            href="/map"
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            2Dマップ
          </Link>
          <Link
            href="/map3d"
            className="px-6 py-3 bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors"
          >
            3Dマップ
          </Link>
        </div>
      </main>
    </div>
  );
}
